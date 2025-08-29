import { generateSchemaTypes, generateReactQueryComponents } from "@openapi-codegen/typescript";
import { defineConfig } from "@openapi-codegen/cli";

export default defineConfig({
  pawtograder: {
    from: {
      relativePath: "../api/swagger.json",
      source: "file"
    },
    outputDir: "lib/generated",
    to: async (context) => {
      const filenamePrefix = "Pawtograder";
      const { schemasFiles } = await generateSchemaTypes(context, {
        filenamePrefix
      });
      await generateReactQueryComponents(context, {
        filenamePrefix,
        schemasFiles
      });
    }
  }
});
