import * as ts from 'typescript';
import * as cs from '../csharp/CSharpAst';
import CSharpEmitterContext from '../csharp/CSharpEmitterContext';
import CSharpAstTransformer from '../csharp/CSharpAstTransformer';

export default class KotlinAstTransformer extends CSharpAstTransformer {
    public constructor(typeScript: ts.SourceFile, context: CSharpEmitterContext) {
        super(typeScript, context);
    }

    private _paramReferences: Map<string, cs.Identifier[]>[] = [];
    private _paramsWithAssignment: Set<string>[] = [];

    private getMethodLocalParameterName(name: string) {
        return 'param' + name;
    }

    protected getIdentifierName(identifier: cs.Identifier, expression: ts.Identifier): string {
        const paramName = super.getIdentifierName(identifier, expression);
        if (
            identifier.tsSymbol &&
            identifier.tsSymbol.valueDeclaration &&
            ts.isParameter(identifier.tsSymbol.valueDeclaration) &&
            !this.isSuperCall(expression.parent)
        ) {
            // TODO: proper scope handling here, first register all parameters when
            // a new scope is started,
            // and here register all identifier usages.
            const currentParamRefs = this._paramReferences[this._paramReferences.length - 1];
            if (currentParamRefs) {
                if (!currentParamRefs.has(paramName)) {
                    currentParamRefs.set(paramName, []);
                }
                currentParamRefs.get(paramName)!.push(identifier);
            }
        }

        return paramName;
    }

    protected visitPrefixUnaryExpression(parent: cs.Node, expression: ts.PrefixUnaryExpression) {
        const pre = super.visitPrefixUnaryExpression(parent, expression);
        if (pre) {
            switch (pre.operator) {
                case '++':
                case '--':
                    const op = this._context.typeChecker.getSymbolAtLocation(expression.operand);
                    if (op?.valueDeclaration && op.valueDeclaration.kind == ts.SyntaxKind.Parameter) {
                        this._paramsWithAssignment[this._paramsWithAssignment.length - 1].add(op.name);
                    }
                    break;
            }
        }
        return pre;
    }

    protected visitPostfixUnaryExpression(parent: cs.Node, expression: ts.PostfixUnaryExpression) {
        const post = super.visitPostfixUnaryExpression(parent, expression);
        if (post) {
            switch (post.operator) {
                case '++':
                case '--':
                    const op = this._context.typeChecker.getSymbolAtLocation(expression.operand);
                    if (op?.valueDeclaration && op.valueDeclaration.kind == ts.SyntaxKind.Parameter) {
                        this._paramsWithAssignment[this._paramsWithAssignment.length - 1].add(op.name);
                    }
                    break;
            }
        }
        return post;
    }

    protected visitBinaryExpression(parent: cs.Node, expression: ts.BinaryExpression) {
        const bin = super.visitBinaryExpression(parent, expression);
        // detect parameter assignment
        if (
            expression.operatorToken.kind == ts.SyntaxKind.EqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.PlusEqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.MinusEqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.AsteriskEqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.LessThanLessThanEqualsToken ||
            expression.operatorToken.kind == ts.SyntaxKind.SlashEqualsToken
        ) {
            const left = this._context.typeChecker.getSymbolAtLocation(expression.left);
            if (left?.valueDeclaration && left.valueDeclaration.kind == ts.SyntaxKind.Parameter) {
                this._paramsWithAssignment[this._paramsWithAssignment.length - 1].add(left.name);
            }
        }
        return bin;
    }

    private isSuperCall(parent: ts.Node): boolean {
        return ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.SuperKeyword;
    }

    private injectParametersAsLocal(block: cs.Block) {
        let localParams: cs.VariableStatement[] = [];

        let currentAssignments = this._paramsWithAssignment[this._paramsWithAssignment.length - 1];
        let currentScope = this._paramReferences[this._paramReferences.length - 1];
        for (const p of currentAssignments) {
            const renamedP = this.getMethodLocalParameterName(p);

            for (const ident of currentScope.get(p)!) {
                ident.text = renamedP;
            }

            const variableStatement = {
                nodeType: cs.SyntaxKind.VariableStatement,
                parent: block,
                tsNode: block.tsNode,
                declarationList: {} as cs.VariableDeclarationList
            } as cs.VariableStatement;

            variableStatement.declarationList = {
                nodeType: cs.SyntaxKind.VariableDeclarationList,
                parent: variableStatement,
                tsNode: block.tsNode,
                declarations: []
            } as cs.VariableDeclarationList;

            let declaration = {
                nodeType: cs.SyntaxKind.VariableDeclaration,
                parent: variableStatement.declarationList,
                tsNode: block.tsNode,
                name: renamedP,
                type: null!,
                initializer: {
                    tsNode: block.tsNode,
                    nodeType: cs.SyntaxKind.Identifier,
                    text: p
                } as cs.Identifier
            } as cs.VariableDeclaration;

            declaration.type = this.createVarTypeNode(declaration, block.tsNode!);
            declaration.initializer!.parent = declaration;

            variableStatement.declarationList.declarations.push(declaration);

            localParams.push(variableStatement);
        }

        block.statements.unshift(...localParams);
    }

    protected visitGetAccessor(parent: cs.ClassDeclaration, classElement: ts.GetAccessorDeclaration) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const el = super.visitGetAccessor(parent, classElement);

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return el;
    }

    protected visitSetAccessor(parent: cs.ClassDeclaration, classElement: ts.SetAccessorDeclaration) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const el = super.visitSetAccessor(parent, classElement);
        if (el.body?.nodeType === cs.SyntaxKind.Block) {
            this.injectParametersAsLocal(el.body as cs.Block);
        }

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return el;
    }

    protected visitConstructorDeclaration(parent: cs.ClassDeclaration, classElement: ts.ConstructorDeclaration) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const constr = super.visitConstructorDeclaration(parent, classElement);

        if (constr.body?.nodeType === cs.SyntaxKind.Block) {
            this.injectParametersAsLocal(constr.body as cs.Block);
        }

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return constr;
    }

    protected visitArrowExpression(parent: cs.Node, expression: ts.ArrowFunction) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const func = super.visitArrowExpression(parent, expression);

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return func;
    }

    protected visitFunctionExpression(parent: cs.Node, expression: ts.FunctionExpression) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const func = super.visitFunctionExpression(parent, expression);

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return func;
    }

    protected visitMethodDeclaration(
        parent: cs.ClassDeclaration | cs.InterfaceDeclaration,
        classElement: ts.MethodDeclaration
    ) {
        this._paramReferences.push(new Map<string, cs.Identifier[]>());
        this._paramsWithAssignment.push(new Set<string>());

        const method = super.visitMethodDeclaration(parent, classElement);

        if (method.body?.nodeType === cs.SyntaxKind.Block) {
            this.injectParametersAsLocal(method.body as cs.Block);
        }

        this._paramReferences.pop();
        this._paramsWithAssignment.pop();

        return method;
    }

    protected visitPropertyAccessExpression(parent: cs.Node, expression: ts.PropertyAccessExpression) {
        const base = super.visitPropertyAccessExpression(parent, expression);

        return base;
    }

    protected getSymbolName(parentSymbol: ts.Symbol, symbol: ts.Symbol, expression: cs.Expression): string | null {
        switch (parentSymbol.name) {
            case 'Array':
                switch (symbol.name) {
                    case 'length':
                        // new Array<string>(other.length)
                        if (
                            expression.parent?.nodeType === cs.SyntaxKind.NewExpression &&
                            (expression.parent.tsNode as ts.NewExpression).arguments?.length === 1 &&
                            ((expression.parent as cs.NewExpression).type as cs.UnresolvedTypeNode).tsType?.symbol
                                ?.name === 'ArrayConstructor'
                        ) {
                            return 'size';
                        }

                        return 'size.toDouble()';
                    case 'push':
                        return 'add';
                    case 'indexOf':
                        return 'indexOfInDouble';
                    case 'filter':
                        return 'filterBy';
                    case 'reverse':
                        return 'rev';
                    case 'fill':
                        return 'fillWith';
                    case 'map':
                        return 'mapTo';
                }
                break;
            case 'String':
                switch (symbol.name) {
                    case 'length':
                        if (
                            expression.parent?.nodeType === cs.SyntaxKind.ReturnStatement ||
                            expression.parent?.nodeType === cs.SyntaxKind.VariableDeclaration ||
                            (expression.parent?.nodeType === cs.SyntaxKind.BinaryExpression &&
                                (expression.parent as cs.BinaryExpression).operator === '=')
                        ) {
                            return 'length.toDouble()';
                        }

                        return 'length.toDouble()';
                    case 'indexOf':
                        return 'indexOfInDouble';
                    case 'lastIndexOf':
                        return 'lastIndexOfInDouble';
                    case 'trimRight':
                        return 'trimEnd';
                }
                break;
        }
        return null;
    }

    private isWithinForInitializer(expression: ts.Node): Boolean {
        if (!expression.parent) {
            return false;
        }

        if (ts.isForStatement(expression.parent) && expression.parent.initializer === expression) {
            return true;
        }

        return this.isWithinForInitializer(expression.parent!);
    }

    protected visitNonNullExpression(parent: cs.Node, expression: ts.NonNullExpression) {
        const nonNullExpression = {
            expression: {} as cs.Expression,
            parent: parent,
            tsNode: expression,
            nodeType: cs.SyntaxKind.NonNullExpression
        } as cs.NonNullExpression;

        nonNullExpression.expression = this.visitExpression(nonNullExpression, expression.expression)!;
        if (!nonNullExpression.expression) {
            return null;
        }

        return nonNullExpression;
    }
}
