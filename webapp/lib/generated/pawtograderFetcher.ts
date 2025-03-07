import { PawtograderContext } from './pawtograderContext';
import { createClient } from "@/utils/supabase/client";

const baseUrl = process.env.NEXT_PUBLIC_PAWTOGRADER_API_URL!;

export type ErrorWrapper<TError> = TError | { status: 'unknown'; payload: string };

export type PawtograderFetcherOptions<TBody, THeaders, TQueryParams, TPathParams> = {
  url: string;
  method: string;
  body?: TBody;
  headers?: THeaders;
  queryParams?: TQueryParams;
  pathParams?: TPathParams;
  signal?: AbortSignal;
} & PawtograderContext['fetcherOptions'];

export async function pawtograderFetch<
  TData,
  TError,
  TBody extends {} | FormData | undefined | null,
  THeaders extends {},
  TQueryParams extends {},
  TPathParams extends {},
>({
  url,
  method,
  body,
  headers,
  pathParams,
  queryParams,
  signal,
}: PawtograderFetcherOptions<TBody, THeaders, TQueryParams, TPathParams>): Promise<TData> {
  try {

    const supabase = createClient();
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;

    const requestHeaders: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': token!,
      ...headers,
    };

    /**
     * As the fetch API is being used, when multipart/form-data is specified
     * the Content-Type header must be deleted so that the browser can set
     * the correct boundary.
     * https://developer.mozilla.org/en-US/docs/Web/API/FormData/Using_FormData_Objects#sending_files_using_a_formdata_object
     */
    if (requestHeaders['Content-Type'].toLowerCase().includes('multipart/form-data')) {
      delete requestHeaders['Content-Type'];
    }

    const response = (typeof window !== 'undefined') ? await window.fetch(`${baseUrl}${resolveUrl(url, queryParams, pathParams)}`, {
      signal,
      method: method.toUpperCase(),
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      headers: requestHeaders,
    }) : await fetch(`${baseUrl}${resolveUrl(url, queryParams, pathParams)}`, {
      signal,
      method: method.toUpperCase(),
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      headers: requestHeaders,
    });
    if (!response.ok) {
      let error: ErrorWrapper<TError>;
      try {
        error = await response.json();
      } catch (e) {
        error = {
          status: 'unknown' as const,
          payload: e instanceof Error ? `Unexpected error (${e.message})` : 'Unexpected error',
        };
      }

      throw error;
    }

    if (response.headers.get('content-type')?.includes('json')) {
      return await response.json();
    } else {
      // if it is not a json response, assume it is a blob and cast it to TData
      return (await response.blob()) as unknown as TData;
    }
  } catch (e) {
    let errorObject: Error = {
      name: 'unknown' as const,
      message: e instanceof Error ? `Network error (${e.message})` : 'Network error',
      stack: e as string,
    };
    throw errorObject;
  }
}

const resolveUrl = (
  url: string,
  queryParams: Record<string, string> = {},
  pathParams: Record<string, string> = {},
) => {
  let query = new URLSearchParams(queryParams).toString();
  if (query) query = `?${query}`;
  return url.replace(/\{\w*\}/g, key => pathParams[key.slice(1, -1)]) + query;
};
