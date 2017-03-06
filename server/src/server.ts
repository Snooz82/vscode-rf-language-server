"use strict";

import * as _ from "lodash";
import * as minimatch from "minimatch";

import {
  IPCMessageReader, IPCMessageWriter,
  createConnection, IConnection, TextDocumentSyncKind,
  TextDocuments, TextDocument, Diagnostic, DiagnosticSeverity,
  InitializeParams, InitializeResult, TextDocumentPositionParams,
  CompletionItem, CompletionItemKind, RequestType,
  Location, Range, DocumentSymbolParams, SymbolInformation,
  FileEvent, FileChangeType
} from "vscode-languageserver";

import { WorkspaceFile, WorkspaceTree } from "./intellisense/workspace-tree";
import { findDefinition } from "./intellisense/definition-finder";
import { getFileSymbols } from "./intellisense/symbol-provider";
import { Settings, Config } from "./utils/settings";

import Uri from "vscode-uri";

import * as asyncFs from "./utils/async-fs";

import { FileParser } from "./parser/parser";
const parser = new FileParser();

const workspaceMap = new WorkspaceTree();

function filePathFromUri(uri: string): string {
  return Uri.parse(uri).path;
}

// Create a connection for the server. The connection uses Node"s IPC as a transport
let connection: IConnection = createConnection(
  new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

const logger = console;

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot: string;
connection.onInitialize((params: InitializeResult) => {
  // workspaceRoot = params.rootPath;
  logger.log("Initializing...");

  return {
    capabilities: {
      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: documents.syncKind,
      // Tell the client that the server support code complete
      completionProvider: {
        resolveProvider: true,
      },
      definitionProvider: true,
      documentSymbolProvider: true
    },
  };
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
// documents.onDidChangeContent(change => {
//   logger.log("onDidChangeContent...");
//   validateDocument(change.document);
// });

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(change => {
  logger.log("onDidChangeConfiguration...");

  if (change.settings && change.settings.rfLanguageServer) {
    Config.setSettings(change.settings.rfLanguageServer);
  }
});

// This handler provides the initial list of the completion items.
// connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
//   logger.log("onCompletion...");

//   // The pass parameter contains the position of the text document in
//   // which code complete got requested. For the example we ignore this
//   // info and always provide the same completion items.
//   return [];
// });

connection.onDocumentSymbol((documentSymbol: DocumentSymbolParams): SymbolInformation[] => {
  logger.log("onDocumentSymbol...");

  const filePath = filePathFromUri(documentSymbol.textDocument.uri);

  const symbols = getFileSymbols(filePath, workspaceMap);
  return symbols.map(symbol => {
    symbol.location = Location.create(
      Uri.file(filePath).toString(),
      Range.create(
        symbol.location.start.line,
        symbol.location.start.column,
        symbol.location.end.line,
        symbol.location.end.column
      )
    );

    return symbol;
  });
});

connection.onDefinition((textDocumentPosition: TextDocumentPositionParams): Location => {
  logger.log("onDefinition...");

  const filePath = filePathFromUri(textDocumentPosition.textDocument.uri);

  const found = findDefinition({
    filePath,
    position: {
      line: textDocumentPosition.position.line,
      column: textDocumentPosition.position.character,
    }
  }, workspaceMap);

  if (!found) {
    return null;
  }

  return Location.create(
    Uri.file(found.filePath).toString(),
    Range.create(
      found.location.start.line,
      found.location.start.column,
      found.location.end.line,
      found.location.end.column
    )
  );
});

// This handler resolve additional information for the item selected in
// the completion list.
// connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
// });

export interface BuildFromFilesParam {
  files: string[];
}

export const BuildFromFilesRequest = new RequestType<BuildFromFilesParam, void, void, void>("buildFromFiles");

connection.onRequest(BuildFromFilesRequest, message => {
  logger.log("buildFromFiles", message);

  message.files.forEach(readAndParseFile);
});

// connection.onDidOpenTextDocument(params => {
//   // A text document got opened in VSCode.
//   // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
//   // params.text the initial full content of the document.
//   logger.log(`${params.textDocument.uri} opened.`);
// });

/**
 * Message sent when the content of a text document did change in VSCode.
 */
connection.onDidChangeTextDocument(params => {
  logger.log("onDidChangeTextDocument");

  // Because syncKind is set to Full, entire file content is received
  const filePath = filePathFromUri(params.textDocument.uri);
  const fileData = _.first(params.contentChanges).text;

  debouncedParseFile(filePath, fileData);
  // params.uri uniquely identifies the document.
  // params.contentChanges describe the content changes to the document.
  // logger.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});

// connection.onDidCloseTextDocument(params => {
//   // A text document got closed in VSCode.
//   // params.uri uniquely identifies the document.
//   logger.log(`${params.textDocument.uri} closed.`);
// });

connection.onDidChangeWatchedFiles(params => {
  logger.log(`onDidChangeWatchedFiles ${ params.changes }`);

  // Remove deleted files
  params.changes
    .filter(change => change.type === FileChangeType.Deleted)
    .map(deletedFile => filePathFromUri(deletedFile.uri))
    .forEach(deletedFilePath => {
      logger.info("Removing file", deletedFilePath);
      workspaceMap.removeFileByPath(deletedFilePath);
    });

  // Parse created files
  params.changes
    .filter(change => change.type === FileChangeType.Created)
    .map(createdFile => filePathFromUri(createdFile.uri))
    .filter(matchFilePathToConfig)
    .forEach(readAndParseFile);
});

function matchFilePathToConfig(filePath: string) {
  const { include, exclude } = Config.getIncludeExclude();

  const hasIncludePatterns = include.length > 0;
  const hasExcludePatterns = exclude.length > 0;

  const shouldInclude = !hasIncludePatterns ||
    _.some(include, pattern => minimatch(filePath, pattern));
  const shouldExclude = hasExcludePatterns &&
    _.some(exclude, pattern => minimatch(filePath, pattern));

  return shouldInclude && !shouldExclude;
}

const debouncedParseFile = _.debounce((filePath: string, fileData: string) => {
    try {
      const parsedFile = parser.parseFile(fileData);
      const file = new WorkspaceFile(filePath, parsedFile);

      workspaceMap.addFile(file);
    } catch (error) {
      logger.error("Failed to parse", filePath, error);
    }
  }, 3000);

function readAndParseFile(filePath: string) {
  logger.info("Parsing", filePath);

  asyncFs.readFileAsync(filePath, "utf-8")
    .then(fileData => parser.parseFile(fileData))
    .then(parsedFile => {
      const file = new WorkspaceFile(filePath, parsedFile);

      workspaceMap.addFile(file);
    })
    .catch(error => {
      logger.error("Failed to parse", filePath, error);
    });
}

// Listen on the connection
connection.listen();
