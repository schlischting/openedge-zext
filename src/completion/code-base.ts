import * as vscode from 'vscode';
import { DocumentController } from '../documentController';
import { StatementUtil } from '../statementUtil';
import { Document } from '../documentModel';

export class CodeCompletionBase implements vscode.CompletionItemProvider {

    protected documentController = DocumentController.getInstance();

    provideCompletionItems(textDocument: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
        let document = this.documentController.getDocument(textDocument);
        if (document) {
            let words = this.splitStatement(textDocument, position);
            if ((!words) || (words.length == 0))
                words = [''];
            let completionItems = this.getCompletion(document, 1,words, textDocument, position);
            completionItems = this.filterCompletionItems(completionItems, document, words, textDocument, position);
            return new vscode.CompletionList([...completionItems]);
        }
        return;
    }

    protected splitStatement(document: vscode.TextDocument, position: vscode.Position): string[] {
        return StatementUtil.dotSplitStatement(document, position);
    }

    protected get maxDeepLevel(): number {
        return 2;
    }

    private getCompletion(document: Document, deepLevel: number, words: string[], textDocument: vscode.TextDocument, position?: vscode.Position): vscode.CompletionItem[] {
        let result = [
            ...this.getCompletionItems(document, words, textDocument, position),
        ];
        if (deepLevel < this.maxDeepLevel) {
            document?.includes.forEach(item => {
                if (item.document) {
                    let itemDocument = this.documentController.getDocument(item.document);
                    if (itemDocument) {
                        let itemResult = this.getCompletion(itemDocument, deepLevel + 1, words, item.document);
                        if (itemResult?.length > 0)
                            result.push(...itemResult);
                    }
                }
            });
        }
        return result;
    }
    

    protected getCompletionItems(document: Document, words: string[], textDocument: vscode.TextDocument, position?: vscode.Position): vscode.CompletionItem[] {
        return [];
    }

    protected filterCompletionItems(items: vscode.CompletionItem[], document: Document, words: string[], textDocument: vscode.TextDocument, position?: vscode.Position): vscode.CompletionItem[] {
        return items;
    }


}