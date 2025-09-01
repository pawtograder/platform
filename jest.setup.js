// Jest setup
require("@testing-library/jest-dom");

process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-service-role-key";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";
process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "https://test.openai.azure.com/";
process.env.AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || "test-azure-key";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic-key";

// Optional: configure or set up a testing framework before each test.
// If you delete this file, remove `setupFilesAfterEnv` from `jest.config.js`

// Used for __tests__/testing-library.js
// Learn more: https://github.com/testing-library/jest-dom
import "@testing-library/jest-dom";

// Mock environment variables
process.env.SUPABASE_URL = "https://test.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
process.env.OPENAI_API_KEY = "test-openai-key";
process.env.AZURE_OPENAI_ENDPOINT = "https://test.openai.azure.com/";
process.env.AZURE_OPENAI_KEY = "test-azure-key";
process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
