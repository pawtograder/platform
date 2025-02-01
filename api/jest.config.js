import { createDefaultEsmPreset } from 'ts-jest'

const presetConfig = createDefaultEsmPreset({

  //...options
})


const esModules = ['get-jwks'].join('|');
/*
If, after upgrading/installing new dependencies, jest complains about 
"cannot use import outside of module" and has a dependency in that trace, add the
dependency to this list of esModules, so that it will be transformed into ESM
*/
const jestConfig = {
  ...presetConfig,
  transform: {
    "^.+.tsx?$": ["ts-jest", {
      "useESM": true
    }],
  },
  moduleNameMapper: {
    '(.+Controller).js': '$1.ts',
    '(.*)/api/authentication.js': '$1/api/authentication.ts',
    '(.*)Types.js': '$1Types.d.ts',
  },
  transformIgnorePatterns: [`/node_modules/(?!${esModules})`],
}

export default jestConfig



// /** @type {import('ts-jest').JestConfigWithTsJest} **/
// export default {
//   testEnvironment: "node",
//   transform: {
//     "^.+.tsx?$": ["ts-jest",{}],
//   },
//   transformIgnorePatterns: [`/node_modules/(?!${esModules})`],
// };