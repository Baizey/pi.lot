import {TestRunner} from "./TestRunner.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => !["--host", "--no-build"].includes(argument))) {
    throw new Error("Usage: node scripts/test-native.mjs [--host] [--no-build]");
}
new TestRunner().native({
    host: arguments_.includes("--host"),
    build: !arguments_.includes("--no-build"),
});
