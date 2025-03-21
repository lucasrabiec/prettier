"use strict";

const { TEST_STANDALONE } = process.env;

const fs = require("fs");
const path = require("path");
const prettier = !TEST_STANDALONE
  ? require("prettier-local")
  : require("prettier-standalone");
const checkParsers = require("./utils/check-parsers.js");
const createSnapshot = require("./utils/create-snapshot.js");
const visualizeEndOfLine = require("./utils/visualize-end-of-line.js");
const consistentEndOfLine = require("./utils/consistent-end-of-line.js");
const stringifyOptionsForTitle = require("./utils/stringify-options-for-title.js");

const { FULL_TEST } = process.env;
const BOM = "\uFEFF";

const CURSOR_PLACEHOLDER = "<|>";
const RANGE_START_PLACEHOLDER = "<<<PRETTIER_RANGE_START>>>";
const RANGE_END_PLACEHOLDER = "<<<PRETTIER_RANGE_END>>>";

// TODO: these test files need fix
const unstableTests = new Map(
  [
    "js/class-comment/misc.js",
    ["js/comments/dangling_array.js", (options) => options.semi === false],
    ["js/comments/jsx.js", (options) => options.semi === false],
    "js/comments/return-statement.js",
    "js/comments/tagged-template-literal.js",
    "markdown/spec/example-234.md",
    "markdown/spec/example-235.md",
    "html/multiparser/js/script-tag-escaping.html",
    [
      "js/multiparser-markdown/codeblock.js",
      (options) => options.proseWrap === "always",
    ],
    ["js/no-semi/comments.js", (options) => options.semi === false],
    ["flow/no-semi/comments.js", (options) => options.semi === false],
    "typescript/prettier-ignore/mapped-types.ts",
    "js/comments/html-like/comment.js",
    "js/for/continue-and-break-comment-without-blocks.js",
    "typescript/satisfies-operators/comments-unstable.ts",
  ].map((fixture) => {
    const [file, isUnstable = () => true] = Array.isArray(fixture)
      ? fixture
      : [fixture];
    return [path.join(__dirname, "../format/", file), isUnstable];
  })
);

const unstableAstTests = new Map();

const espreeDisabledTests = new Set(
  [
    // These tests only work for `babel`
    "comments-closure-typecast",
  ].map((directory) => path.join(__dirname, "../format/js", directory))
);
const acornDisabledTests = espreeDisabledTests;
const meriyahDisabledTests = new Set([
  ...espreeDisabledTests,
  // Meriyah does not support decorator auto accessors syntax.
  // But meriyah can parse it as an ordinary class property.
  // So meriyah does not throw parsing error for it.
  ...[
    "basic.js",
    "computed.js",
    "private.js",
    "static-computed.js",
    "static-private.js",
    "static.js",
    "with-semicolon-1.js",
    "with-semicolon-2.js",
  ].map((filename) =>
    path.join(__dirname, "../format/js/decorator-auto-accessors", filename)
  ),
  path.join(
    __dirname,
    "../format/js/babel-plugins/decorator-auto-accessors.js"
  ),
]);

const isUnstable = (filename, options) => {
  const testFunction = unstableTests.get(filename);

  if (!testFunction) {
    return false;
  }

  return testFunction(options);
};

const isAstUnstable = (filename, options) => {
  const testFunction = unstableAstTests.get(filename);

  if (!testFunction) {
    return false;
  }

  return testFunction(options);
};

const shouldThrowOnFormat = (filename, options) => {
  const { errors = {} } = options;
  if (errors === true) {
    return true;
  }

  const files = errors[options.parser];

  if (files === true || (Array.isArray(files) && files.includes(filename))) {
    return true;
  }

  return false;
};

const isTestDirectory = (dirname, name) =>
  (dirname + path.sep).startsWith(
    path.join(__dirname, "../format", name) + path.sep
  );

function runSpec(fixtures, parsers, options) {
  let { dirname, snippets = [] } =
    typeof fixtures === "string" ? { dirname: fixtures } : fixtures;

  // `IS_PARSER_INFERENCE_TESTS` mean to test `inferParser` on `standalone`
  const IS_PARSER_INFERENCE_TESTS = isTestDirectory(
    dirname,
    "misc/parser-inference"
  );

  // `IS_ERROR_TESTS` mean to watch errors like:
  // - syntax parser hasn't supported yet
  // - syntax errors that should throws
  const IS_ERROR_TESTS = isTestDirectory(dirname, "misc/errors");
  if (IS_ERROR_TESTS) {
    options = { errors: true, ...options };
  }

  const IS_TYPESCRIPT_ONLY_TEST = isTestDirectory(
    dirname,
    "misc/typescript-only"
  );

  if (IS_PARSER_INFERENCE_TESTS) {
    parsers = [undefined];
  }

  snippets = snippets.map((test, index) => {
    test = typeof test === "string" ? { code: test } : test;
    return {
      ...test,
      name: `snippet: ${test.name || `#${index}`}`,
    };
  });

  const files = fs
    .readdirSync(dirname, { withFileTypes: true })
    .map((file) => {
      const basename = file.name;
      const filename = path.join(dirname, basename);
      if (
        path.extname(basename) === ".snap" ||
        !file.isFile() ||
        basename[0] === "." ||
        basename === "jsfmt.spec.js" ||
        // VSCode creates this file sometime https://github.com/microsoft/vscode/issues/105191
        basename === "debug.log"
      ) {
        return;
      }

      const text = fs.readFileSync(filename, "utf8");

      return {
        name: basename,
        filename,
        code: text,
      };
    })
    .filter(Boolean);

  // Make sure tests are in correct location
  if (process.env.CHECK_TEST_PARSERS) {
    if (!Array.isArray(parsers) || parsers.length === 0) {
      throw new Error(`No parsers were specified for ${dirname}`);
    }
    checkParsers({ dirname, files }, parsers);
  }

  const [parser] = parsers;
  const allParsers = [...parsers];

  if (!IS_ERROR_TESTS) {
    if (
      parsers.includes("typescript") &&
      !parsers.includes("babel-ts") &&
      !IS_TYPESCRIPT_ONLY_TEST
    ) {
      allParsers.push("babel-ts");
    }

    if (parsers.includes("babel") && isTestDirectory(dirname, "js")) {
      if (!parsers.includes("espree") && !espreeDisabledTests.has(dirname)) {
        allParsers.push("espree");
      }
      if (!parsers.includes("meriyah") && !meriyahDisabledTests.has(dirname)) {
        allParsers.push("meriyah");
      }
      if (!parsers.includes("acorn") && !acornDisabledTests.has(dirname)) {
        allParsers.push("acorn");
      }
    }

    if (parsers.includes("babel") && !parsers.includes("__babel_estree")) {
      allParsers.push("__babel_estree");
    }
  }

  const stringifiedOptions = stringifyOptionsForTitle(options);

  for (const { name, filename, code, output } of [...files, ...snippets]) {
    const title = `${name}${
      stringifiedOptions ? ` - ${stringifiedOptions}` : ""
    }`;

    describe(title, () => {
      const formatOptions = {
        printWidth: 80,
        // Should not search plugins by default
        pluginSearchDirs: false,
        ...options,
        filepath: filename,
        parser,
      };
      const shouldThrowOnMainParserFormat = shouldThrowOnFormat(
        name,
        formatOptions
      );

      let mainParserFormatResult;
      if (shouldThrowOnMainParserFormat) {
        mainParserFormatResult = { options: formatOptions, error: true };
      } else {
        beforeAll(async () => {
          mainParserFormatResult = await format(code, formatOptions);
        });
      }

      for (const currentParser of allParsers) {
        if (
          (currentParser === "espree" && espreeDisabledTests.has(filename)) ||
          (currentParser === "meriyah" && meriyahDisabledTests.has(filename)) ||
          (currentParser === "acorn" && acornDisabledTests.has(filename))
        ) {
          continue;
        }

        const testTitle =
          shouldThrowOnMainParserFormat ||
          formatOptions.parser !== currentParser
            ? `[${currentParser}] format`
            : "format";

        test(testTitle, async () => {
          await runTest({
            parsers,
            name,
            filename,
            code,
            output,
            parser: currentParser,
            mainParserFormatResult,
            mainParserFormatOptions: formatOptions,
          });
        });
      }
    });
  }
}

async function runTest({
  parsers,
  name,
  filename,
  code,
  output,
  parser,
  mainParserFormatResult,
  mainParserFormatOptions,
}) {
  let formatOptions = mainParserFormatOptions;
  let formatResult = mainParserFormatResult;

  // Verify parsers or error tests
  if (
    mainParserFormatResult.error ||
    mainParserFormatOptions.parser !== parser
  ) {
    formatOptions = { ...mainParserFormatResult.options, parser };
    const runFormat = () => format(code, formatOptions);

    if (shouldThrowOnFormat(name, formatOptions)) {
      await expect(runFormat()).rejects.toThrowErrorMatchingSnapshot();
      return;
    }

    // Verify parsers format result should be the same as main parser
    output = mainParserFormatResult.outputWithCursor;
    formatResult = await runFormat();
  }

  // Make sure output has consistent EOL
  expect(formatResult.eolVisualizedOutput).toEqual(
    visualizeEndOfLine(consistentEndOfLine(formatResult.outputWithCursor))
  );

  // The result is assert to equals to `output`
  if (typeof output === "string") {
    expect(formatResult.eolVisualizedOutput).toEqual(
      visualizeEndOfLine(output)
    );
    return;
  }

  // All parsers have the same result, only snapshot the result from main parser
  expect(
    createSnapshot(formatResult, {
      parsers,
      formatOptions,
      CURSOR_PLACEHOLDER,
    })
  ).toMatchSnapshot();

  if (!FULL_TEST) {
    return;
  }

  const isUnstableTest = isUnstable(filename, formatOptions);
  if (
    (formatResult.changed || isUnstableTest) &&
    // No range and cursor
    formatResult.input === code
  ) {
    const { eolVisualizedOutput: firstOutput, output } = formatResult;
    const { eolVisualizedOutput: secondOutput } = await format(
      output,
      formatOptions
    );
    if (isUnstableTest) {
      // To keep eye on failed tests, this assert never supposed to pass,
      // if it fails, just remove the file from `unstableTests`
      expect(secondOutput).not.toEqual(firstOutput);
    } else {
      expect(secondOutput).toEqual(firstOutput);
    }
  }

  const isAstUnstableTest = isAstUnstable(filename, formatOptions);
  // Some parsers skip parsing empty files
  if (formatResult.changed && code.trim()) {
    const { input, output } = formatResult;
    const originalAst = parse(input, formatOptions);
    const formattedAst = parse(output, formatOptions);
    if (isAstUnstableTest) {
      expect(formattedAst).not.toEqual(originalAst);
    } else {
      expect(formattedAst).toEqual(originalAst);
    }
  }

  if (!shouldSkipEolTest(code, formatResult.options)) {
    for (const eol of ["\r\n", "\r"]) {
      const { eolVisualizedOutput: output } = await format(
        code.replace(/\n/g, eol),
        formatOptions
      );
      // Only if `endOfLine: "auto"` the result will be different
      const expected =
        formatOptions.endOfLine === "auto"
          ? visualizeEndOfLine(
              // All `code` use `LF`, so the `eol` of result is always `LF`
              formatResult.outputWithCursor.replace(/\n/g, eol)
            )
          : formatResult.eolVisualizedOutput;
      expect(output).toEqual(expected);
    }
  }

  if (code.charAt(0) !== BOM) {
    const { eolVisualizedOutput: output } = await format(
      BOM + code,
      formatOptions
    );
    const expected = BOM + formatResult.eolVisualizedOutput;
    expect(output).toEqual(expected);
  }
}

function shouldSkipEolTest(code, options) {
  if (code.includes("\r")) {
    return true;
  }
  const { requirePragma, rangeStart, rangeEnd } = options;
  if (requirePragma) {
    return true;
  }

  if (
    typeof rangeStart === "number" &&
    typeof rangeEnd === "number" &&
    rangeStart >= rangeEnd
  ) {
    return true;
  }
  return false;
}

function parse(source, options) {
  return prettier.__debug.parse(source, options, /* massage */ true).ast;
}

const indexProperties = [
  {
    property: "cursorOffset",
    placeholder: CURSOR_PLACEHOLDER,
  },
  {
    property: "rangeStart",
    placeholder: RANGE_START_PLACEHOLDER,
  },
  {
    property: "rangeEnd",
    placeholder: RANGE_END_PLACEHOLDER,
  },
];
function replacePlaceholders(originalText, originalOptions) {
  const indexes = indexProperties
    .map(({ property, placeholder }) => {
      const value = originalText.indexOf(placeholder);
      return value === -1 ? undefined : { property, value, placeholder };
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value);

  const options = { ...originalOptions };
  let text = originalText;
  let offset = 0;
  for (const { property, value, placeholder } of indexes) {
    text = text.replace(placeholder, "");
    options[property] = value + offset;
    offset -= placeholder.length;
  }
  return { text, options };
}

const insertCursor = (text, cursorOffset) =>
  cursorOffset >= 0
    ? text.slice(0, cursorOffset) +
      CURSOR_PLACEHOLDER +
      text.slice(cursorOffset)
    : text;
// eslint-disable-next-line require-await
async function format(originalText, originalOptions) {
  const { text: input, options } = replacePlaceholders(
    originalText,
    originalOptions
  );
  const inputWithCursor = insertCursor(input, options.cursorOffset);

  const { formatted: output, cursorOffset } = prettier.formatWithCursor(
    input,
    options
  );
  const outputWithCursor = insertCursor(output, cursorOffset);
  const eolVisualizedOutput = visualizeEndOfLine(outputWithCursor);

  const changed = outputWithCursor !== inputWithCursor;

  return {
    changed,
    options,
    input,
    inputWithCursor,
    output,
    outputWithCursor,
    eolVisualizedOutput,
  };
}

module.exports = runSpec;
