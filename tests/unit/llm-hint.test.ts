import { NextRequest } from "next/server";
import { POST } from "@/app/api/llm-hint/route";
import { createClient } from "@/utils/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { AzureChatOpenAI, ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import * as Sentry from "@sentry/nextjs";
import { LLMRateLimitConfig } from "@/utils/supabase/DatabaseTypes";

// Mock all external dependencies
jest.mock("@/utils/supabase/server");
jest.mock("@supabase/supabase-js");
jest.mock("@langchain/openai");
jest.mock("@langchain/anthropic");
jest.mock("@langchain/core/prompts");
jest.mock("@sentry/nextjs");

const mockCreateClient = createClient as jest.MockedFunction<typeof createClient>;
const mockCreateServiceClient = createServiceClient as jest.MockedFunction<typeof createServiceClient>;
const mockAzureChatOpenAI = AzureChatOpenAI as jest.MockedClass<typeof AzureChatOpenAI>;
const mockChatOpenAI = ChatOpenAI as jest.MockedClass<typeof ChatOpenAI>;
const mockChatAnthropic = ChatAnthropic as jest.MockedClass<typeof ChatAnthropic>;
const mockChatPromptTemplate = ChatPromptTemplate as jest.MockedClass<typeof ChatPromptTemplate>;
const mockSentry = Sentry as jest.Mocked<typeof Sentry>;

describe("LLM Hint API Route", () => {
  interface MockQueryBuilder {
    select: jest.MockedFunction<(query?: string) => MockQueryBuilder>;
    eq: jest.MockedFunction<(column?: string, value?: unknown) => MockQueryBuilder>;
    neq: jest.MockedFunction<(column?: string, value?: unknown) => MockQueryBuilder>;
    order: jest.MockedFunction<(column?: string, options?: { ascending: boolean }) => MockQueryBuilder>;
    limit: jest.MockedFunction<(count?: number) => MockQueryBuilder>;
    single: jest.MockedFunction<() => Promise<{ data: unknown; error: unknown | null }>>;
    insert: jest.MockedFunction<(data: unknown) => Promise<{ error: unknown | null }>>;
    update: jest.MockedFunction<
      (data: unknown) => {
        eq: jest.MockedFunction<(column: string, value: unknown) => Promise<{ error: unknown | null }>>;
      }
    >;
    in: jest.MockedFunction<
      (column?: string, values?: unknown[]) => Promise<{ count?: number; error: unknown | null; data?: unknown }>
    >;
  }

  let mockSupabase: {
    auth: { getUser: jest.MockedFunction<() => Promise<{ data: { user: unknown } }>> };
    from: jest.MockedFunction<(table?: string) => MockQueryBuilder>;
  };
  let mockServiceSupabase: {
    from: jest.MockedFunction<(table?: string) => MockQueryBuilder>;
  };
  let mockUser: { id: string; email: string };
  let mockTestResult: {
    id: number;
    class_id: number;
    extra_data: {
      llm?: {
        prompt?: string;
        result?: string;
        model?: string;
        provider?: string;
        type: string;
        rate_limit?: LLMRateLimitConfig;
        temperature?: number;
        max_tokens?: number;
        account?: string;
      };
    };
    grader_results: {
      submissions: {
        id: number;
        class_id: number;
        assignment_id: number;
      };
    };
  };
  let mockChain: { invoke: jest.MockedFunction<(input: unknown) => Promise<unknown>> };
  let mockResponse: {
    content: string;
    usage_metadata?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  let serviceQueryBuilder: MockQueryBuilder;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock user
    mockUser = {
      id: "user-123",
      email: "test@example.com"
    };

    // Mock test result
    mockTestResult = {
      id: 1,
      class_id: 100,
      extra_data: {
        llm: {
          prompt: "Test prompt",
          model: "gpt-4o-mini",
          provider: "openai",
          type: "v1"
        }
      },
      grader_results: {
        submissions: {
          id: 456,
          class_id: 100,
          assignment_id: 789
        }
      }
    };

    // Mock LLM response
    mockResponse = {
      content: "Test AI response",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 50
      }
    };

    // Mock chain
    mockChain = {
      invoke: jest.fn().mockResolvedValue(mockResponse)
    };

    // Mock Supabase client
    const mockQueryBuilder: MockQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: mockTestResult, error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null })
      }),
      in: jest.fn().mockResolvedValue({ count: 0, error: null })
    } as unknown as MockQueryBuilder;

    mockSupabase = {
      auth: {
        getUser: jest.fn().mockResolvedValue({ data: { user: mockUser } })
      },
      from: jest.fn().mockReturnValue(mockQueryBuilder)
    };

    // Mock service Supabase client (with from() returning a shared chainable builder)
    serviceQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      insert: jest.fn().mockResolvedValue({ error: null }),
      update: jest.fn().mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: null })
      }),
      in: jest.fn().mockReturnThis()
    };
    mockServiceSupabase = {
      from: jest.fn().mockReturnValue(serviceQueryBuilder)
    } as unknown as typeof mockServiceSupabase;

    // Setup mocks
    mockCreateClient.mockResolvedValue(mockSupabase as unknown as Awaited<ReturnType<typeof createClient>>);
    mockCreateServiceClient.mockReturnValue(mockServiceSupabase as unknown as ReturnType<typeof createServiceClient>);
    (mockChatPromptTemplate.fromMessages as jest.Mock).mockReturnValue({
      pipe: jest.fn().mockReturnValue(mockChain)
    });

    // Ensure env vars are set for provider tests (avoid bleed from other tests)
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";
    process.env.AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "https://test.openai.azure.com/";
    process.env.AZURE_OPENAI_KEY = process.env.AZURE_OPENAI_KEY || "test-azure-key";
    process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic-key";
  });

  describe("Authentication and Authorization", () => {
    it("should return 401 when user is not authenticated", async () => {
      mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } });

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toBe("Authentication required");
    });

    it("should return 404 when test result is not found", async () => {
      (
        (mockSupabase.from() as unknown as MockQueryBuilder).select("*").eq("id", 1).single as jest.Mock
      ).mockResolvedValue({
        data: null,
        error: { message: "Not found" }
      });

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe("Test result not found or access denied");
    });

    it("should return 400 when testId is invalid", async () => {
      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: -1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("testId must be a non-negative integer");
    });

    it("should return 400 when testId is not a number", async () => {
      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: "invalid" })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("testId must be a non-negative integer");
    });
  });

  describe("LLM Configuration Validation", () => {
    it("should return 400 when no LLM configuration is found", async () => {
      mockTestResult.extra_data = {};

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("No LLM hint prompt found for this test");
    });

    it("should return 400 when LLM prompt is missing", async () => {
      mockTestResult.extra_data = {
        llm: {
          model: "gpt-4o-mini",
          provider: "openai",
          type: "v1"
        }
      };

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      // Route validates earlier and returns the generic 'no prompt found' when llm is missing prompt
      expect(data.error).toBe("No LLM hint prompt found for this test");
    });
  });

  describe("Caching Behavior", () => {
    it("should return cached result when hint already exists", async () => {
      mockTestResult.extra_data = {
        llm: {
          prompt: "Test prompt",
          result: "Cached response",
          model: "gpt-4o-mini",
          provider: "openai",
          type: "v1"
        }
      };

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.response).toBe("Cached response");
      expect(data.cached).toBe(true);
    });
  });

  describe("Rate Limiting", () => {
    describe("Cooldown Rate Limiting", () => {
      it("should return 429 when cooldown period has not elapsed", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { cooldown: 5 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock recent usage (2 minutes ago, cooldown is 5 minutes)
        const recentUsage = {
          created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString()
        };
        const cooldownSingle = (mockServiceSupabase.from() as unknown as MockQueryBuilder)
          .select("*")
          .eq("submissions.assignment_id", 1)
          .neq("submission_id", 1)
          .order("created_at", { ascending: false })
          .limit(1).single as unknown as jest.Mock;
        cooldownSingle.mockResolvedValue({
          data: recentUsage,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(429);
        expect(data.error).toContain("Rate limit: Please wait 3 more minute(s)");
      });

      it("should allow request when cooldown period has elapsed", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { cooldown: 5 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock old usage (10 minutes ago, cooldown is 5 minutes)
        const oldUsage = {
          created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString()
        };
        serviceQueryBuilder.single.mockResolvedValue({
          data: oldUsage,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      });

      it("should allow request when no previous usage exists", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { cooldown: 5 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock no previous usage
        serviceQueryBuilder.single.mockResolvedValue({
          data: null,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      });
    });

    describe("Assignment Total Rate Limiting", () => {
      it("should return 429 when assignment total limit is reached", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { assignment_total: 10 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock assignment submissions
        const assignmentSubmissions = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          data: assignmentSubmissions,
          error: null
        });

        // Mock usage count at limit
        (serviceQueryBuilder.in as unknown as jest.Mock).mockResolvedValueOnce({
          count: 10,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(429);
        expect(data.error).toContain(
          "Rate limit: Maximum number of Feedbot responses (10) for this assignment has been reached"
        );
      });

      it("should allow request when assignment total limit is not reached", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { assignment_total: 10 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock assignment submissions
        const assignmentSubmissions = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          data: assignmentSubmissions,
          error: null
        });

        // Mock usage count below limit
        (serviceQueryBuilder.in as unknown as jest.Mock).mockResolvedValueOnce({
          count: 5,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      });
    });

    describe("Class Total Rate Limiting", () => {
      it("should return 429 when class total limit is reached", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { class_total: 50 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock class usage count at limit
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          count: 50,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(429);
        expect(data.error).toContain(
          "Rate limit: Maximum number of Feedbot responses (50) for this class has been reached"
        );
      });

      it("should allow request when class total limit is not reached", async () => {
        const rateLimitConfig: LLMRateLimitConfig = { class_total: 50 };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock class usage count below limit
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          count: 25,
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      });
    });

    describe("Combined Rate Limiting", () => {
      it("should check all rate limits when multiple are configured", async () => {
        const rateLimitConfig: LLMRateLimitConfig = {
          cooldown: 5,
          assignment_total: 10,
          class_total: 50
        };
        mockTestResult.extra_data.llm!.rate_limit = rateLimitConfig;

        // Mock cooldown: eq().neq().order().limit().single() -> single returns no recent usage
        serviceQueryBuilder.single.mockResolvedValue({
          data: null, // No recent usage
          error: null
        });

        // First eq call is part of cooldown chain, keep it chainable
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockReturnValueOnce(serviceQueryBuilder);

        const assignmentSubmissions = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
        // Next eq (submissions query) should resolve to submissions list
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          data: assignmentSubmissions,
          error: null
        });

        (serviceQueryBuilder.in as unknown as jest.Mock).mockResolvedValueOnce({
          count: 5, // Below assignment limit
          error: null
        });

        // Class usage under limit
        (serviceQueryBuilder.eq as unknown as jest.Mock).mockResolvedValueOnce({
          count: 25, // Below class limit
          error: null
        });

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(200);
        expect(data.success).toBe(true);
      });
    });
  });

  describe("LLM Provider Configuration", () => {
    describe("OpenAI Provider", () => {
      it("should use OpenAI provider with default settings", async () => {
        mockTestResult.extra_data.llm!.provider = "openai";
        mockTestResult.extra_data.llm!.model = "gpt-4o-mini";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(mockChatOpenAI).toHaveBeenCalledWith({
          model: "gpt-4o-mini",
          apiKey: "test-openai-key",
          temperature: 0.85,
          maxTokens: undefined,
          maxRetries: 2
        });
      });

      it("should use OpenAI provider with custom settings", async () => {
        mockTestResult.extra_data.llm!.provider = "openai";
        mockTestResult.extra_data.llm!.model = "gpt-4";
        mockTestResult.extra_data.llm!.temperature = 0.5;
        mockTestResult.extra_data.llm!.max_tokens = 1000;
        mockTestResult.extra_data.llm!.account = "account1";

        process.env.OPENAI_API_KEY_account1 = "test-account-key";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(mockChatOpenAI).toHaveBeenCalledWith({
          model: "gpt-4",
          apiKey: "test-account-key",
          temperature: 0.5,
          maxTokens: 1000,
          maxRetries: 2
        });
      });

      it("should return 500 when OpenAI API key is missing", async () => {
        delete process.env.OPENAI_API_KEY;
        mockTestResult.extra_data.llm!.provider = "openai";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(500);
        expect(data.error).toBe("OpenAI API key is required, must set env var OPENAI_API_KEY");
      });
    });

    describe("Azure Provider", () => {
      it("should use Azure provider with default settings", async () => {
        mockTestResult.extra_data.llm!.provider = "azure";
        mockTestResult.extra_data.llm!.model = "gpt-4o-mini";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(mockAzureChatOpenAI).toHaveBeenCalledWith({
          model: "gpt-4o-mini",
          temperature: 0.85,
          maxTokens: undefined,
          maxRetries: 2,
          azureOpenAIApiKey: "test-azure-key",
          azureOpenAIApiInstanceName: "test.openai.azure.com",
          azureOpenAIApiDeploymentName: "gpt-4o-mini",
          azureOpenAIApiVersion: "2024-05-01-preview"
        });
      });

      it("should return 500 when Azure endpoint is missing", async () => {
        delete process.env.AZURE_OPENAI_ENDPOINT;
        mockTestResult.extra_data.llm!.provider = "azure";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(500);
      });

      it("should return 500 when Azure API key is missing", async () => {
        delete process.env.AZURE_OPENAI_KEY;
        mockTestResult.extra_data.llm!.provider = "azure";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(500);
      });
    });

    describe("Anthropic Provider", () => {
      it("should use Anthropic provider with default settings", async () => {
        mockTestResult.extra_data.llm!.provider = "anthropic";
        mockTestResult.extra_data.llm!.model = "claude-3-sonnet-20240229";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);

        expect(response.status).toBe(200);
        expect(mockChatAnthropic).toHaveBeenCalledWith({
          model: "claude-3-sonnet-20240229",
          apiKey: "test-anthropic-key",
          temperature: 0.85,
          maxTokens: undefined,
          maxRetries: 2
        });
      });

      it("should return 500 when Anthropic API key is missing", async () => {
        delete process.env.ANTHROPIC_API_KEY;
        mockTestResult.extra_data.llm!.provider = "anthropic";

        const request = new NextRequest("http://localhost:3000/api/llm-hint", {
          method: "POST",
          body: JSON.stringify({ testId: 1 })
        });

        const response = await POST(request);
        const data = await response.json();

        expect(response.status).toBe(500);
        expect(data.error).toBe("Anthropic API key is required, must set env var ANTHROPIC_API_KEY");
      });
    });

    it("should return 400 for invalid provider", async () => {
      mockTestResult.extra_data.llm!.provider = "invalid-provider";

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe("Invalid provider: invalid-provider. Supported providers are: openai, azure, anthropic");
    });
  });

  describe("LLM Response Handling", () => {
    it("should return 500 when no response is received from AI provider", async () => {
      mockChain.invoke.mockResolvedValue(null);

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("No response received from AI provider");
    });

    it("should handle response without usage metadata", async () => {
      mockResponse.usage_metadata = undefined;

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.response).toBe("Test AI response");
    });
  });

  describe("Database Operations", () => {
    it("should store the LLM result in the database", async () => {
      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockServiceSupabase.from as unknown as jest.Mock).toHaveBeenCalledWith("grader_result_tests");
      expect(serviceQueryBuilder.update).toHaveBeenCalledWith({
        extra_data: expect.objectContaining({
          llm: expect.objectContaining({
            result: "Test AI response"
          })
        })
      });
    });

    it("should track LLM usage statistics", async () => {
      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      expect(mockServiceSupabase.from as unknown as jest.Mock).toHaveBeenCalledWith("llm_inference_usage");
      expect(serviceQueryBuilder.insert).toHaveBeenCalledWith({
        class_id: 100,
        created_by: "user-123",
        grader_result_test_id: 1,
        submission_id: 456,
        account: "default",
        model: "gpt-4o-mini",
        provider: "openai",
        input_tokens: 100,
        output_tokens: 50
      });
    });

    it("should continue processing even if database update fails", async () => {
      serviceQueryBuilder.update.mockReturnValue({
        eq: jest.fn().mockResolvedValue({ error: { message: "Database error" } })
      });

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockSentry.captureException).toHaveBeenCalled();
    });

    it("should continue processing even if usage tracking fails", async () => {
      serviceQueryBuilder.insert.mockResolvedValue({
        error: { message: "Usage tracking error" }
      });

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockSentry.captureException).toHaveBeenCalled();
    });
  });

  describe("Error Handling", () => {
    it("should handle unexpected errors gracefully", async () => {
      mockSupabase.auth.getUser.mockRejectedValue(new Error("Unexpected error"));

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("An unexpected error occurred. Please try again.");
      expect(mockSentry.captureException).toHaveBeenCalled();
    });

    it("should handle non-Error exceptions", async () => {
      mockSupabase.auth.getUser.mockRejectedValue("String error");

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      const response = await POST(request);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toBe("An unexpected error occurred. Please try again.");
    });
  });

  describe("Sentry Integration", () => {
    it("should set Sentry tags and user context", async () => {
      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      await POST(request);

      expect(mockSentry.setTag).toHaveBeenCalledWith("testId", 1);
      expect(mockSentry.setUser).toHaveBeenCalledWith({ id: "user-123" });
    });

    it("should capture exceptions with proper context", async () => {
      (
        (mockSupabase.from() as unknown as MockQueryBuilder).select("*").eq("id", 1).single as jest.Mock
      ).mockResolvedValue({
        data: null,
        error: { message: "Test error" }
      });

      const request = new NextRequest("http://localhost:3000/api/llm-hint", {
        method: "POST",
        body: JSON.stringify({ testId: 1 })
      });

      await POST(request);

      expect(mockSentry.captureException).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          tags: expect.objectContaining({
            operation: "fetch_test_result",
            testId: "1"
          })
        })
      );
    });
  });
});
