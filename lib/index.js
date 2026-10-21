// The loader accepts this entry path (lib/index.js) from install time, so keep the
// file name stable and delegate to the tools build.
export { name, inject, apply } from './tools.js'
