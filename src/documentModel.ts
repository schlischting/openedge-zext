import * as vscode from "vscode";
import * as utils from './utils';
import * as fs from 'fs';
import { DocumentController } from "./documentController";
import { AblMethod, ABL_SCOPE, AblVariable, AblParameter, ABL_ASLIKE, ABL_TYPE, ABL_BUFFER_TYPE, ABL_PARAM_DIRECTION, ABL_METHOD_TYPE, ABL_BLOCK_SCOPE, AblInclude, AblTempTable, AblField } from "./documentDefinition";
import { SourceParser, SourceCode } from "./sourceParser";
import { DbfController } from "./dbfController";
import { O_TRUNC } from "constants";

export class Document {

    private readonly UPDATE_DEBOUNCE = 2500;
    private readonly QUICKUPDATE_DEBOUNCE = 500;
    private inProgress = false;
    private debounceUpdate;
    private textDocument: vscode.TextDocument;

    //#region 
    private documentIncludes: AblInclude[] = [];
    private documentMethods: AblMethod[] = [];
    private documentVariables: AblVariable[] = [];
    private documentTempTables: AblTempTable[] = [];
    //#endregion

    constructor(document: vscode.TextDocument) {
        this.textDocument = document;
        this.initialize();
    }

    dispose() {
        this.resetDebounceUpdate();
    }

    private initialize() {
        // monitor external files
        DocumentController.getInstance().onChange(doc => this.checkExternalReferenceUpdate(doc));
        // monitor update
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.uri.fsPath == this.textDocument.uri.fsPath) {
                this.setDebounceUpdate();
            }
        }, this);
        // queue first update
        this.setDebounceUpdate();
    }

    get document(): vscode.TextDocument {
        return this.textDocument;
    }

    get includes() {
        return this.documentIncludes;
    }

    get methods() {
        return this.documentMethods;
    }

    get variables() {
        return this.documentVariables;
    }

    get tempTables() {
        return this.documentTempTables;
    }

    update() {
        if (!this.inProgress) {
            this.refreshDocument();
        }
        else {
            // TODO - timeout control????

            //
            this.setDebounceUpdate();
        }
    }

    private resetDebounceUpdate() {
        if (this.debounceUpdate)
            clearTimeout(this.debounceUpdate);
        this.debounceUpdate = null;
    }

    private setDebounceUpdate(quick?:boolean) {
        this.resetDebounceUpdate();
        this.debounceUpdate = setTimeout(this.update.bind(this), (quick ? this.QUICKUPDATE_DEBOUNCE : this.UPDATE_DEBOUNCE));
    }

    private refreshDocument() {
        this.resetDebounceUpdate();
        this.inProgress = true;
        try {
            let source = new SourceParser().getSourceCode(this.textDocument);
            this.refreshIncludes(source).then(() => {

                this.refreshMethods(source);
                this.refreshVariables(source);
                this.refreshParameters(source);
                this.refreshTempTables(source);
                this.updateExternalReferences();
    
                // TODO - only when model updated
    
                process.nextTick(() => DocumentController.getInstance().pushDocumentChange(this));
            })
            .finally(() => this.inProgress = false);
            
        }
        catch {
            this.inProgress = false;
        }
    }

    private checkExternalReferenceUpdate(doc: Document) {
        if (this.documentIncludes.find(item => item.uri.fsPath == doc.document.uri.fsPath)) {
            this.setDebounceUpdate(true);
        }
    }

    private updateExternalReferences() {
        
        // TODO
        this.updateTempTableReferences();

    }

    private refreshIncludes(source: SourceCode) {
        let controller = DocumentController.getInstance();
        let result: AblInclude[] = [];
        let text = source.sourceWithoutStrings;
        let reStart: RegExp = new RegExp(/\{{1}([\w\d\-\\\/\.]+)/gim);
        // 1 = include name
        let reEnd: RegExp = new RegExp(/\}{1}/gim);
        //
        let matchStart = reStart.exec(text);
        let matchEnd;
        while(matchStart) {
            reEnd.lastIndex = reStart.lastIndex;
            matchEnd = reEnd.exec(text);
            if (matchEnd) {
                let name = matchStart[1].trim().toLowerCase();
                // ignores {1} (include parameter) and {&ANYTHING} (global/scoped definition)
                if ((Number.isNaN(Number.parseInt(name))) && (!name.startsWith('&')) && (!result.find(item => item.name == name))) {
                    let item: AblInclude = {
                        name: name
                    }
                    result.push(item);
                }
                matchStart = reStart.exec(text);
            }
            else {
                break;
            }
        }
        this.documentIncludes = result;

        return new Promise(resolve => {
            let pending: Promise<any>[] = [];
            result.forEach(item => {
                pending.push(controller.getUri(item.name).then(uri => {
                    item.uri = uri;
                    if (item.uri) {
                        item.document = controller.getDocument(item.uri)?.document;
                        if (!item.document) {
                            process.nextTick(() => { controller.openDocument(item.uri).then(document => item.document = document) });
                        }
                    }
                }));
            });
            Promise.all(pending).then(() => resolve());
        });
        // request to open the includes
        
    }

    private refreshMethods(source: SourceCode) {
        let result: AblMethod[] = [];
        let text = source.sourceWithoutStrings;

        let reStart = new RegExp(/\b(proc|procedure|func|function){1}[\s\t\n]+([\w\d\-]+)(.*?)(?:[\.\:][^\w\d\-\+])/gim);
        // 1 = function | procedure
        // 2 = name
        // 3 = aditional details (returns xxx, private, etc)
        let reEnd = new RegExp(/\b(?:end[\s\t]+(proc|procedure|func|function)){1}\b/gim);
        let matchStart = reStart.exec(text);
        let matchEnd;
        while(matchStart) {
            reEnd.lastIndex = reStart.lastIndex;
            matchEnd = reEnd.exec(text);
            if (matchEnd) {
                try {
                    let posStart = source.document.positionAt(matchStart.index);
                    let posEnd = source.document.positionAt(reEnd.lastIndex);
                    let item: AblMethod = {
                        name: matchStart[2],
                        type: ABL_METHOD_TYPE.PROCEDURE,
                        range: new vscode.Range(posStart, posEnd),
                        scope: this.getScope(matchStart[3]),
                        params: [],
                        localVariables: []
                    }
                    result.push(item);
                }
                catch {}
                matchStart = reStart.exec(text);
            }
            else {
                break;
            }
        }
        this.resolveMethodConflicts(source,result);
        this.documentMethods = result;
    }

    private resolveMethodConflicts(source: SourceCode, methods: AblMethod[]) {
        // adjust method start/end lines (missing "procedure" on "end [procedure]")
        let prevMethod: AblMethod;
        methods.forEach(method => {
            if (prevMethod) {
                if (method.range.start.isBefore(prevMethod.range.end)) {
                    let posEnd = source.document.positionAt(source.document.offsetAt(method.range.start) - 1);
                    prevMethod.range = new vscode.Range(prevMethod.range.start, posEnd);
                }
            }
            prevMethod = method;
        });
    }

    private refreshVariables(source: SourceCode) {
        let result: AblVariable[] = [];
        let text = source.sourceWithoutStrings;

        // VARIABLES
        let reDefineVar = new RegExp(/(?:def|define){1}(?:[\s\t\n]|new|shared)+(?:var|variable){1}(?:[\s\t\n]+)([\w\d\-]+)[\s\t\n]+(as|like){1}[\s\t\n]+([\w\d\-\.]+)([\n\s\t\w\d\-\'\"]*)\./gim);
        // 1 = var name
        // 2 = as | like
        // 3 = type | field like
        // 4 = details (extent, no-undo, initial, etc)
        let matchDefineVar = reDefineVar.exec(text);
        while(matchDefineVar) {
            try {
                let item = this.variableAsVariable(matchDefineVar[1],matchDefineVar[2],matchDefineVar[3],matchDefineVar[4]);
                item.position = source.document.positionAt(matchDefineVar.index);
                result.push(item);
            }
            catch {}
            matchDefineVar = reDefineVar.exec(text);
        }

        // BUFFERS
        let reDefineBuffer = new RegExp(/(?:def|define){1}(?:[\s\t\n]|new|shared)+(?:buffer){1}[\s\t\n]+([\w\d\-]+){1}[\s\t\n]+(?:for){1}[\s\t\n]+(temp-table[\s\t\n]+)*([\w\d\-\+]*)(?:\.[^\w\d\-\+])+/gim);
        // 1 = buffer name
        // 2 = undefined | temp-table
        // 3 = buffer value
        let matchDefineBuffer = reDefineBuffer.exec(text);
        while(matchDefineBuffer) {
            try {
                let item = this.bufferAsVariable(matchDefineBuffer[1],matchDefineBuffer[2],matchDefineBuffer[3]);
                item.position = source.document.positionAt(matchDefineBuffer.index);
                result.push(item);
            }
            catch {}
            matchDefineBuffer = reDefineBuffer.exec(text);
        }

        // add into local or global vars
        this.documentVariables = [];
        result.forEach(item => {
            let method = this.methodInPosition(item.position);
            if (method) {
                item.scope = ABL_BLOCK_SCOPE.LOCAL;
                method.localVariables.push(item);
            }
            else {
                item.scope = ABL_BLOCK_SCOPE.GLOBAL;
                this.documentVariables.push(item);
            }
        });
    }

    private refreshParameters(source: SourceCode) {
        let result: AblParameter[] = [];
        let text = source.sourceWithoutStrings;

        // PRIMITIVE
        let rePrimitive = new RegExp(/\b(?:def|define){1}[\s\t\n]+((?:input)|(?:output)|(?:input-output)|(?:return)){1}[\s\t\n]+(?:param|parameter){1}[\s\t\n]+([\w\d\-\.]*){1}[\s\t\n]+(as|like){1}[\s\t\n]+([\w\d\-\.]+)([\n\s\t\w\d\-\'\"]*)\./gim);
        // 1 = input | output | input-output | return
        // 2 = name
        // 3 = as | like
        // 4 = type | field like
        // 5 = details
        let matchPrimitive = rePrimitive.exec(text);
        while(matchPrimitive) {
            try {
                let item: AblParameter = this.variableAsVariable(matchPrimitive[2],matchPrimitive[3],matchPrimitive[4],matchPrimitive[5]);
                item.position = source.document.positionAt(matchPrimitive.index);
                item.direction = this.getDirection(matchPrimitive[1]);
                item.scope = ABL_BLOCK_SCOPE.LOCAL;
                result.push(item);
            }
            catch {} // suppress errors
            matchPrimitive = rePrimitive.exec(text);
        }

        // TEMP-TABLE
        let reTempTable = new RegExp(/\b(?:def|define){1}[\s\t\n]+((?:input)|(?:output)|(?:input-output)){1}[\s\t\n]+(?:param|parameter){1}[\s\t\n]+(?:table){1}[\s\t\n]+(?:for){1}[\s\t\n]+([\w\d\-\+]*)(?:\.[^\w\d\-\+]){1}/gim);
        // 1 = input | output | input-output
        // 2 = name
        let matchTempTable = reTempTable.exec(text);
        while(matchTempTable) {
            try {
                let item: AblParameter = this.tempTableAsVariable(matchTempTable[2]);
                item.position = source.document.positionAt(matchTempTable.index);
                item.direction = this.getDirection(matchTempTable[1]);
                item.scope = ABL_BLOCK_SCOPE.LOCAL;
                result.push(item);
            }
            catch {} // suppress errors
            matchTempTable = reTempTable.exec(text);
        }

        // BUFFER
        let reBuffer = new RegExp(/\b(?:def|define){1}[\s\t\n]+(?:param|parameter){1}[\s\t\n]+(?:buffer){1}[\s\t\n]+([\w\d\-]+){1}[\s\t\n]+(?:for){1}[\s\t\n]+(temp-table[\s\t\n]+)*([\w\d\-\+]*)(?:\.[^\w\d\-\+])+/gim);
        // 1 = name
        // 2 = undefined | temp-table
        // 3 = buffer reference
        let matchBuffer = reBuffer.exec(text);
        while(matchBuffer) {
            try {
                let item: AblParameter = this.bufferAsVariable(matchBuffer[1],matchBuffer[2],matchBuffer[3]);
                item.position = source.document.positionAt(matchBuffer.index);
                item.scope = ABL_BLOCK_SCOPE.LOCAL;
                result.push(item);
            }
            catch {}
            matchBuffer = reBuffer.exec(text);
        }

        // add into methods
        result.sort((v1,v2) => v1.position.compareTo(v2.position)).forEach(item => {
            let method = this.methodInPosition(item.position);
            if (method)
                method.params.push(item);
        });
    }

    private refreshTempTables(source: SourceCode) {
        let result: AblTempTable[] = [];
        let text = source.sourceWithoutStrings;

        let reStart: RegExp = new RegExp(/\b(?:def|define){1}(?:[\s\t\n]|new|global|shared)+(?:temp-table){1}[\s\t\n\r]+([\w\d\-\+]*)[^\w\d\-\+]/gim);
        // 1 = name
        let reEnd: RegExp = new RegExp(/\.[^\w\d\-\+]/gim);
        //
        let reLike: RegExp = new RegExp(/\b(?:like){1}[\s\t\n]+([\w\d\-\+]+)[\s\t\n]*(?:\.[^\w\d\-\+]+|field|index|[\s\t\n\r])(?!field|index)/gim);
        // 1 = temp-table like
        let matchStart = reStart.exec(text);
        let matchEnd;
        let matchLike;
        while(matchStart) {
            reEnd.lastIndex = reStart.lastIndex;
            matchEnd = reEnd.exec(text);
            if (matchEnd) {
                try {
                    let posStart = source.document.positionAt(matchStart.index);
                    let posEnd = source.document.positionAt(reEnd.lastIndex);
                    let innerText = text.substring(reStart.lastIndex, matchEnd.index);
                    let item: AblTempTable = {
                        name: matchStart[1],
                        range: new vscode.Range(posStart, posEnd)
                    };
                    // check for reference table
                    reLike.lastIndex = reStart.lastIndex;
                    matchLike = reLike.exec(text);
                    if ((matchLike)&&(matchLike.index <= reEnd.lastIndex)&&(matchLike.index >= reStart.lastIndex)) {
                        item.referenceTable = matchLike[1];
                    }
                    // fields
                    item.fields = this.extractTempTableFields(innerText, source);
                    item.indexes = this.extractTempTableIndexes(innerText, source);
                    result.push(item);
                }
                catch {}
                matchStart = reStart.exec(text);
            }
            else {
                break;
            }
        }

        this.documentTempTables = result;
        // this.updateTempTableReferences();
    }

    private extractTempTableFields(text: string, source: SourceCode): AblField[] {
        let result: AblField[] = [];
        let regexDefineField: RegExp = new RegExp(/(?:field){1}(?:[\s\t\n]+)([\w\d\-]+)[\s\t\n]+(as|like){1}[\s\t\n]+([\w\d\-\.]+)/gim);
        // 1 = var name
        // 2 = as | like
        // 3 = type | field like
        let res = regexDefineField.exec(text);
        while(res) {
            try {
                let item: AblField = { name: res[1] };
                if (res[2].toLowerCase() == ABL_ASLIKE.AS)
                    item.dataType = this.normalizeDataType(res[3]);
                else if (res[2].toLowerCase() == ABL_ASLIKE.AS)
                    item.likeType = this.normalizeDataType(res[3]);
                result.push(item);
            }
            catch {}
            res = regexDefineField.exec(text);
        }
        return result;
    }

    private extractTempTableIndexes(text: string, source: SourceCode) {
        // TODO - is needed?
        return [];
    }

    private updateTempTableReferences() {
        let dbf = DbfController.getInstance();
        // insert reference fields
        this.documentTempTables.filter(item => !!item.referenceTable).forEach(item => {
            // avoid looping
            if (item.name.toLowerCase() == item.referenceTable.toLowerCase())
                return;
            // like database table
            let table = dbf.getTable(item.referenceTable);
            if (table) {
                item.referenceFields = table.fields.map(f => { return <AblField>{ name: f.name, dataType: f.type } });
            }
            // like temp-table
            else {
                let tt = this.documentTempTables.find(rt => rt.name.toLowerCase() == item.referenceTable.toLowerCase());
                // local
                if (tt) {
                    item.referenceFields = [...tt.fields];
                }
                // external
                else {
                    let controller = DocumentController.getInstance();
                    this.documentIncludes.filter(i => !!i.document).find(i => {
                        let doc = controller.getDocument(i.document);
                        if (doc) {
                            tt = doc.tempTables.find(et => et.name.toLowerCase() == item.referenceTable.toLowerCase());
                            if (tt)
                                return true;
                        }
                        return false;
                    });
                    if (tt) {
                        item.referenceFields = [...tt.fields];
                    }
                }
            }
        });
    }

    private getScope(details?:string): ABL_SCOPE {
        let split = (details || '').trim().toLowerCase().split(' ');
        if (split.includes(ABL_SCOPE.PRIVATE))
            return ABL_SCOPE.PRIVATE;
        if (split.includes(ABL_SCOPE.PROTECTED))
            return ABL_SCOPE.PROTECTED;
        return ABL_SCOPE.PUBLIC;
    }

    private getDirection(text:string): ABL_PARAM_DIRECTION {
        if (text.toLowerCase() == ABL_PARAM_DIRECTION.RETURN)
            return ABL_PARAM_DIRECTION.RETURN;
        if (text.toLowerCase() == ABL_PARAM_DIRECTION.OUT)
            return ABL_PARAM_DIRECTION.OUT;
        if (text.toLowerCase() == ABL_PARAM_DIRECTION.INOUT)
            return ABL_PARAM_DIRECTION.INOUT;
        return ABL_PARAM_DIRECTION.IN;
    }

    private variableAsVariable(pName:string,pAsLike:string,pType:string,pAdditional:string): AblVariable {
        let item: AblVariable = {
            name: pName.trim(),
            additional: (pAdditional || ``).trim()
        }
        if (pAsLike.toLowerCase() == ABL_ASLIKE.AS) {
            item.dataType = this.normalizeDataType(pType);
        }
        else if (pAsLike.toLowerCase() == ABL_ASLIKE.LIKE) {
            item.likeType = this.normalizeDataType(pType);
        }
        return item;
    }

    private bufferAsVariable(pName:string,pBufferType:string,pReference:string): AblVariable {
        let item: AblVariable = {
            name: pName.trim(),
            dataType: ABL_TYPE.BUFFER,
            likeType: pReference.trim().toLowerCase()
        }
        if ((pBufferType || '').toLowerCase() == ABL_BUFFER_TYPE.TEMP_TABLE) {
            item.bufferType = ABL_BUFFER_TYPE.TEMP_TABLE;
        }
        else {
            item.bufferType = ABL_BUFFER_TYPE.TABLE;
        }
        return item;
    }

    private tempTableAsVariable(pName:string): AblVariable {
        let item: AblVariable = {
            name: pName.trim(),
            dataType: ABL_TYPE.TEMP_TABLE
        }
        return item;
    }

    private normalizeDataType(value:string): string {
        value = value.trim().toLowerCase();
        let regexValidWordEnd: RegExp = new RegExp(/[\w\d]$/);
        while(!regexValidWordEnd.test(value)) 
            value = value.substring(0, value.length-1);
        return value;
    }

    methodInPosition(position: vscode.Position): AblMethod {
        return this.documentMethods.find(m => m.range.contains(position));
    }

}