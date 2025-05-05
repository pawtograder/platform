import JSZip from "jszip";
import { resolve, dirname } from "path";

function getMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "html":
      return "text/html";
    case "css":
      return "text/css";
    case "js":
      return "application/javascript";
    case "json":
      return "application/json";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "ttf":
      return "font/ttf";
    case "eot":
      return "application/vnd.ms-fontobject";
    case "otf":
      return "font/otf";
    default:
      return "application/octet-stream";
  }
}

type ZipToHtmlBlobsResult = {
  rewrittenHTMLFiles: Map<string, string>;
  topLevelDir: string;
};
export default async function zipToHTMLBlobs(data: Blob): Promise<ZipToHtmlBlobsResult> {
  const zip = await JSZip.loadAsync(data);
  const rewrittenHTMLFiles = new Map<string, string>();
  //Find that top level directory that contains an index.html file
  let topLevelDir = null;
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.name.endsWith("index.html")) {
      const numSlashes = path.split("/").length - 1;
      if (!topLevelDir || numSlashes < topLevelDir.split("/").length) {
        topLevelDir = path.split("/").slice(0, -1).join("/");
      }
    }
  }
  //Now process all the HTML files, rewriting the URLs to the blob URLs
  for (const [completePath, file] of Object.entries(zip.files)) {
    if (file.name.endsWith("html")) {
      const path = completePath.replace(topLevelDir!, "");
      const content = await file.async("text");

      const doc = new DOMParser().parseFromString(content, "text/html");

      // Rewrite all URLs in the document to be ABSOLUTE to the top-level directory
      function rewriteUrl(url: string) {
        if (url.startsWith("http")) {
          return url;
        }
        // Remove any leading slashes
        const cleanUrl = url.replace(/^\//, "");
        // Resolve the path relative to the current file's directory
        const resolvedPath = resolve(dirname(path), cleanUrl);
        // Make it absolute relative to the top-level directory
        return resolvedPath;
      }

      doc.querySelectorAll("a").forEach((link) => {
        const href = link.getAttribute("href");
        if (href) {
          link.setAttribute("href", rewriteUrl(href));
        }
      });
      doc.querySelectorAll("script[src]").forEach((script) => {
        const src = script.getAttribute("src");
        if (src) {
          script.setAttribute("src", rewriteUrl(src));
        }
      });
      doc.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
        const href = link.getAttribute("href");
        if (href) {
          link.setAttribute("href", rewriteUrl(href));
        }
      });
      doc.querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src");
        if (src) {
          img.setAttribute("src", rewriteUrl(src));
        }
      });

      // Add a script to handle URL rewriting when the page loads
      const script = doc.createElement("script");
      script.textContent = `
                // Store blob URLs in a global object
                if(!window.__blobUrls){
                    window.__blobUrls = new Map();
                }
                
                window.addEventListener('load', function() {
                    // Request the file contents from the parent frame
                    if(!window.__blobUrls.size){
                        window.parent.postMessage({ type: 'REQUEST_FILE_CONTENTS' }, '*');
                    }
                    
                    // Listen for the response with file contents
                    window.addEventListener('message', function(event) {
                        if (event.data.type === 'FILE_CONTENTS_RESPONSE') {
                            const fileContents = event.data.fileContents;
                            // Create blob URLs for all files
                            for (const [path, content] of Object.entries(fileContents)) {
                                const blob = new Blob([content], { type: getMimeType(path) });
                                window.__blobUrls.set(path, URL.createObjectURL(blob));
                            }
                            
                            function rewriteUrl(url) {
                                if (!url) return url;
                                if(url.startsWith('/')){
                                    const hashMark = url.indexOf('#');
                                    url = hashMark === -1 ? url : url.substring(0, hashMark);
                                    const blobUrl = window.__blobUrls.get(url);
                                    if (blobUrl) {
                                        const ret = blobUrl;
                                        if(hashMark === -1){
                                            return ret;
                                        }
                                        return ret + url.substring(hashMark);
                                    }
                                }
                                return url;
                            }
                            
                            // Handle all existing elements
                            function rewriteAllUrls() {
                                // Handle links
                                document.querySelectorAll('a').forEach(link => {
                                    const href = link.getAttribute('href');
                                    if (href) {
                                        link.setAttribute('href', rewriteUrl(href));
                                    }
                                });
                                
                                // Handle scripts
                                document.querySelectorAll('script[src]').forEach(script => {
                                    const src = script.getAttribute('src');
                                    if (src) {
                                        script.setAttribute('src', rewriteUrl(src));
                                    }
                                });
                                
                                // Handle stylesheets
                                document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                                    const href = link.getAttribute('href');
                                    if (href) {
                                        link.setAttribute('href', rewriteUrl(href));
                                    }
                                });
                                
                                // Handle images
                                document.querySelectorAll('img').forEach(img => {
                                    const src = img.getAttribute('src');
                                    if (src) {
                                        img.setAttribute('src', rewriteUrl(src));
                                    }
                                });
                            }
                            
                            // Rewrite all existing URLs
                            rewriteAllUrls();
                            
                            // Set up observer for dynamically added elements
                            const observer = new MutationObserver(function(mutations) {
                                mutations.forEach(function(mutation) {
                                    if (mutation.addedNodes) {
                                        mutation.addedNodes.forEach(function(node) {
                                            if (node.nodeType === 1) { // Element node
                                                // Handle links
                                                node.querySelectorAll('a').forEach(link => {
                                                    const href = link.getAttribute('href');
                                                    if (href) {
                                                        link.setAttribute('href', rewriteUrl(href));
                                                    }
                                                });
                                                
                                                // Handle scripts
                                                node.querySelectorAll('script[src]').forEach(script => {
                                                    const src = script.getAttribute('src');
                                                    if (src) {
                                                        script.setAttribute('src', rewriteUrl(src));
                                                    }
                                                });
                                                
                                                // Handle stylesheets
                                                node.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                                                    const href = link.getAttribute('href');
                                                    if (href) {
                                                        link.setAttribute('href', rewriteUrl(href));
                                                    }
                                                });
                                                
                                                // Handle images
                                                node.querySelectorAll('img').forEach(img => {
                                                    const src = img.getAttribute('src');
                                                    if (src) {
                                                        img.setAttribute('src', rewriteUrl(src));
                                                    }
                                                });
                                            }
                                        });
                                    }
                                });
                            });
                            
                            // Start observing the document for changes
                            observer.observe(document.documentElement, {
                                childList: true,
                                subtree: true
                            });
                        }
                    });
                });
                
                // Helper function to get MIME type
                function getMimeType(filename) {
                    const ext = filename.split('.').pop()?.toLowerCase();
                    switch (ext) {
                        case 'html': return 'text/html';
                        case 'css': return 'text/css';
                        case 'js': return 'application/javascript';
                        case 'json': return 'application/json';
                        case 'png': return 'image/png';
                        case 'jpg':
                        case 'jpeg': return 'image/jpeg';
                        case 'gif': return 'image/gif';
                        case 'svg': return 'image/svg+xml';
                        case 'ico': return 'image/x-icon';
                        case 'woff': return 'font/woff';
                        case 'woff2': return 'font/woff2';
                        case 'ttf': return 'font/ttf';
                        case 'eot': return 'application/vnd.ms-fontobject';
                        case 'otf': return 'font/otf';
                        default: return 'application/octet-stream';
                    }
                }
            `;
      doc.head.appendChild(script);

      // Instead of using XMLSerializer, create the HTML string manually
      const htmlString = `<!DOCTYPE html>
<html>
<head>${doc.head.innerHTML}</head>
<body>${doc.body.innerHTML}</body>
</html>`;

      rewrittenHTMLFiles.set(path, htmlString);
    }
  }
  return { rewrittenHTMLFiles, topLevelDir: topLevelDir! };
}
