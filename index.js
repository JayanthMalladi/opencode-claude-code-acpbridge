// Local-directory entrypoint for OpenCode's plugin loader (Host.resolve looks for
// `<dir>/index.*` when the configured plugin target is a directory). npm installs
// resolve through package.json `exports` instead and never touch this file.
export * from "./dist/index.js";
export { default } from "./dist/index.js";
