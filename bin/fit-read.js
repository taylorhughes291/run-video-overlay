#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const FitParser =
  require("fit-file-parser").default || require("fit-file-parser");

function printUsageAndExit() {
  console.error(
    "Usage: fit-read <path-to-file.fit> [--out output.json] [--pretty]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { input: null, out: null, pretty: false };
  const tokens = argv.slice(2);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!args.input && !token.startsWith("--")) {
      args.input = token;
      continue;
    }
    if (token === "--out") {
      if (i + 1 >= tokens.length) printUsageAndExit();
      args.out = tokens[++i];
      continue;
    }
    if (token === "--pretty") {
      args.pretty = true;
      continue;
    }
    printUsageAndExit();
  }
  if (!args.input) printUsageAndExit();
  return args;
}

function main() {
  const { input, out, pretty } = parseArgs(process.argv);
  const resolvedPath = path.resolve(process.cwd(), input);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`File not found: ${resolvedPath}`);
    process.exit(2);
  }
  const content = fs.readFileSync(resolvedPath);
  const fitParser = new FitParser({
    force: true,
    speedUnit: "m/s",
    lengthUnit: "m",
    temperatureUnit: "celsius",
    elapsedRecordField: true,
    mode: "cascade",
  });

  fitParser.parse(content, function (error, data) {
    if (error) {
      console.error("Failed to parse .fit file:", error.message || error);
      process.exit(3);
    }
    const json = JSON.stringify(data, null, pretty ? 2 : 0);
    if (out) {
      const outPath = path.resolve(process.cwd(), out);
      fs.writeFileSync(outPath, json);
      console.log(`Wrote parsed JSON to ${outPath}`);
    } else {
      process.stdout.write(json + "\n");
    }
  });
}

main();
