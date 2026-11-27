const fs = require("node:fs");
const ts = require("typescript");

// Interpret only the data syntax used by the public catalog modules. An
// unsupported expression stops the sync before it can write the snapshot.
function readCatalogData(filename) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = new Map();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) &&
        statement.declarationList.getFirstToken(source)?.kind === ts.SyntaxKind.ConstKeyword) {
      for (const { name, initializer } of statement.declarationList.declarations) {
        if (ts.isIdentifier(name) && initializer) declarations.set(name.text, initializer);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
    }
  }

  function unsupported(node) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    throw new Error(`Unsupported catalog expression at ${filename}:${line}`);
  }

  const cached = new Map();
  function value(name) {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Missing catalog definition ${name} in ${filename}`);
    if (!cached.has(name)) cached.set(name, read(declaration, new Map()));
    return cached.get(name);
  }

  function read(node, parameters) {
    const data = child => read(child, parameters);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isIdentifier(node)) return parameters.has(node.text) ? parameters.get(node.text) : value(node.text);
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      return data(node.expression);
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap(element => {
        if (!ts.isSpreadElement(element)) return [data(element)];
        const values = data(element.expression);
        return Array.isArray(values) ? values : unsupported(element);
      });
    }
    if (ts.isObjectLiteralExpression(node)) {
      return Object.fromEntries(node.properties.map(property => {
        if (ts.isShorthandPropertyAssignment(property) && !property.objectAssignmentInitializer) {
          return [property.name.text, data(property.name)];
        }
        if (!ts.isPropertyAssignment(property) ||
            !(ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) || ts.isNumericLiteral(property.name))) {
          return unsupported(property);
        }
        return [property.name.text, data(property.initializer)];
      }));
    }
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map(span => data(span.expression) + span.literal.text).join("");
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const [argument] = node.arguments;
      const callee = node.expression;
      if (ts.isIdentifier(callee) && ["options", "models"].includes(callee.text)) {
        return readDefinition(callee.text, data(argument));
      }
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "map" && ts.isArrowFunction(argument)) {
        const [parameter] = argument.parameters;
        const array = data(callee.expression);
        if (!parameter || !ts.isArrayBindingPattern(parameter.name) || !Array.isArray(array)) return unsupported(node);
        const names = parameter.name.elements.map(element => {
          if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name) ||
              element.initializer || element.dotDotDotToken) return unsupported(element);
          return element.name.text;
        });
        return array.map(entry => {
          if (!Array.isArray(entry)) return unsupported(node);
          const scope = new Map([...parameters, ...names.map((name, index) => [name, entry[index]])]);
          return read(argument.body, scope);
        });
      }
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const object = data(node.expression);
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : data(node.argumentExpression);
      return object != null && Object.hasOwn(object, key) ? object[key] : undefined;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      return data(node.left) === data(node.right);
    }
    if (ts.isConditionalExpression(node)) return data(node.condition) ? data(node.whenTrue) : data(node.whenFalse);
    return unsupported(node);
  }

  function readDefinition(name, input) {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Missing catalog definition ${name} in ${filename}`);
    if (!(ts.isFunctionDeclaration(declaration) || ts.isArrowFunction(declaration)) || !declaration.body) {
      return unsupported(declaration);
    }
    const { body, parameters: [parameter] } = declaration;
    if (parameter && !ts.isIdentifier(parameter.name)) return unsupported(parameter);
    const locals = new Map(parameter ? [[parameter.name.text, input]] : []);
    if (!ts.isBlock(body)) return read(body, locals);
    const [statement] = body.statements;
    if (body.statements.length === 1 && ts.isReturnStatement(statement) && statement.expression) {
      return read(statement.expression, locals);
    }
    return unsupported(body);
  }

  return { value, optionLabel: id => readDefinition("getMarketplaceCategoryOptionLabel", id) };
}

module.exports = { readCatalogData };
