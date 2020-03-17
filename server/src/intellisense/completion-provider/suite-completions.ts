import * as _ from "lodash";
import { TestSuite } from "../../parser/models";
import { Location } from "../../utils/position";
import { CompletionItem } from "vscode-languageserver";
import { getSyntaxCompletions } from "./completion-helper";
import { LocationInfo } from "../node-locator";

/**
 * Return the completions for data tables
 */
export function getCompletions(
  location: Location,
  locationInfo: LocationInfo,
  fileAst: TestSuite
): CompletionItem[] {
  const { row, cell, textBefore: text } = locationInfo;

  if (row.indexOf(cell) !== 0 || !text.startsWith("*")) {
    return [];
  }

  const missingTables = _getMissingTables(fileAst, text);
  const sanitizedText = text.replace(/\*/g, "").replace(/ /g, "");
  return getSyntaxCompletions(sanitizedText, missingTables);
}

function _escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

function _getMissingTables(ast: TestSuite, text: string) {
  const tables = [];

  const re = new RegExp(`^${_escapeRegExp(text.substr(0, 3))}`, "g");

  if (!ast.settingsTable) {
    tables.push("*** Settings ***".replace(re, ""));
  }
  if (!ast.variablesTable) {
    tables.push("*** Variables ***".replace(re, ""));
  }
  if (!ast.keywordsTable) {
    tables.push("*** Keywords ***".replace(re, ""));
  }
  if (!ast.testCasesTable) {
    tables.push("*** Test Cases ***".replace(re, ""));
  }

  return tables;
}
