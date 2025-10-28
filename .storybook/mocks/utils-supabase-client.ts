export function createClient() {
  return {
    functions: {
      invoke: async () => ({ data: { url: "about:blank" } })
    },
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob(), error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "about:blank" }, error: null })
      })
    }
  } as any;
}
