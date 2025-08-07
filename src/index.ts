#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

// Create an MCP server
const server = new McpServer({
    name: "ContentExtractor",
    version: "1.0.1"
});

// Initialize Turndown service for HTML to Markdown conversion
const turndownService = new TurndownService();

// Function to clean HTML content
const cleanHtml = (htmlContent: string): string => {
    if (!htmlContent) {
        return "";
    }

    const $ = cheerio.load(htmlContent);

    // Try standard content containers first
    const contentSelectors = [
        "article",
        "#article",
        ".article",
        "main",
        "#main",
        ".main",
        '[role="main"]',
        "#content",
        ".content",
        ".post",
    ];

    let $content = $(); // Initialize an empty Cheerio object

    for (const selector of contentSelectors) {
        const selected = $(selector);
        if (selected.length === 1) {
            $content = selected.first(); // Use the first match
            break;
        }
    }

    // If no specific container found, use the body, otherwise use the found container
    const $target = $content.length > 0 ? $content : $('body');

    // Define elements to remove
    const elementsToRemove = [
        "header", "footer", "nav", '[role="navigation"]', "aside", ".sidebar",
        '[role="complementary"]', ".nav", ".menu", ".header", ".footer",
        ".advertisement", ".ads", ".cookie-notice", ".social-share",
        ".related-posts", ".comments", "#comments", ".popup", ".modal",
        ".overlay", ".banner", ".alert", ".notification", ".subscription",
        ".newsletter", ".share-buttons", "script", "style", "noscript", "iframe",
        "button", "form", "input", "textarea", "select", // Form elements often not needed
        ".noprint", // Common class for non-printable content
    ];

    // Remove unwanted elements within the target container
    $target.find(elementsToRemove.join(', ')).remove();

    // Clean unwanted attributes from all elements within the target
    $target.find('*').each((_, element) => {
        const el = $(element);
        // Remove style attributes
        el.removeAttr('style');
        // Clean data URLs in src (replace with placeholder)
        const src = el.attr('src');
        if (src && src.startsWith('data:')) {
            el.attr('src', '...');
        }
        // Remove common tracking/event attributes
        ['onclick', 'onload', 'onerror', 'onmouseover', 'onmouseout', 'onfocus', 'onblur', 'target'].forEach(attr => el.removeAttr(attr));
    });

    // Get the HTML of the cleaned content
    let cleanedHtml = $target.html() || '';

    // Further clean whitespace and normalize
    cleanedHtml = cleanedHtml.replace(/[\t\r\n]+/g, ' '); // Replace tabs, newlines, carriage returns with a single space
    cleanedHtml = cleanedHtml.replace(/\s{2,}/g, ' '); // Replace multiple spaces with a single space
    cleanedHtml = cleanedHtml.trim(); // Trim leading/trailing whitespace

    return cleanedHtml;
};


// Add the content extraction tool
server.tool(
    "extract-content",
    "Extracts the main textual content from a given URL, converts it to Markdown, and returns the result.",
    { url: z.string().url("The URL must be a valid HTTP or HTTPS web address.").describe("The publicly accessible HTTP or HTTPS URL of the web page to extract content from.") },
    async ({ url }) => {
        try {
            // Validate URL protocol
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
                if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
                    console.error(`Invalid protocol: ${parsedUrl.protocol} for URL: ${url}`);
                    return {
                        content: [{ type: "text", text: `Error: URL must use HTTP or HTTPS protocol.` }],
                        isError: true
                    };
                }
            } catch (e) {
                // This should theoretically not happen due to Zod validation, but catch just in case
                console.error(`Error parsing URL ${url}:`, e);
                return {
                    content: [{ type: "text", text: `Error: Invalid URL format.` }],
                    isError: true
                };
            }

            console.log(`Fetching content from: ${url}`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

            let response;
            try {
                response = await fetch(url, { signal: controller.signal });
            } catch (fetchError: any) {
                clearTimeout(timeoutId); // Clear timeout if fetch fails for other reasons
                if (fetchError.name === 'AbortError') {
                    console.error(`Fetch timed out for ${url}`);
                    return {
                        content: [{ type: "text", text: `Error: Request timed out fetching URL.` }],
                        isError: true
                    };
                }
                // Re-throw other fetch errors to be caught by the main catch block
                throw fetchError;
            } finally {
                clearTimeout(timeoutId); // Always clear timeout after fetch completes or fails
            }


            if (!response.ok) {
                console.error(`HTTP error! status: ${response.status} for ${url}`);
                return {
                    content: [{ type: "text", text: `Error: Failed to fetch URL. Status: ${response.status}` }],
                    isError: true
                };
            }

            const contentType = response.headers.get("content-type");
            if (!contentType || !contentType.includes("text/html")) {
                console.warn(`Non-HTML content type received: ${contentType} for ${url}`);
                // Attempt to read as text anyway, might be useful
                const textContent = await response.text();
                return {
                    content: [{ type: "text", text: `Warning: Content type is not HTML (${contentType}). Raw text:\n${textContent.substring(0, 500)}...` }]
                };
            }

            const htmlContent = await response.text();
            console.log(`Successfully fetched HTML (${Math.round(htmlContent.length / 1024)} KB) from: ${url}`);

            console.log(`Cleaning HTML for: ${url}`);
            const cleanedHtml = cleanHtml(htmlContent);
            console.log(`HTML cleaned (${Math.round(cleanedHtml.length / 1024)} KB) for: ${url}`);

            // Add validation for empty content after cleaning
            if (!cleanedHtml || cleanedHtml.trim().length === 0) {
                console.warn(`Cleaning resulted in empty HTML content for: ${url}`);
                return {
                    content: [{ type: "text", text: "Warning: Extracted content is empty after cleaning HTML." }]
                };
            }

            console.log(`Converting cleaned HTML to Markdown for: ${url}`);
            const markdownContent = turndownService.turndown(cleanedHtml);
            console.log(`Converted to Markdown (${Math.round(markdownContent.length / 1024)} KB) for: ${url}`);

            // Add validation for empty content after cleaning and conversion
            if (!markdownContent || markdownContent.trim().length === 0) {
                console.warn(`Extraction resulted in empty content for: ${url}`);
                return {
                    content: [{ type: "text", text: "Warning: Extracted content is empty after cleaning and conversion." }]
                };
            }

            return {
                content: [{ type: "text", text: markdownContent }] // Return as text, client can interpret as Markdown
            };

        } catch (error: unknown) {
            console.error(`Error processing URL ${url}:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
                content: [{ type: "text", text: `Error processing URL: ${errorMessage}` }],
                isError: true
            };
        }
    }
);

// Start the server with StdioTransport
const startServer = async () => {
    try {
        const transport = new StdioServerTransport();
        console.log("MCP Server starting with stdio transport...");
        await server.connect(transport);
        console.log("MCP Server connected and listening on stdio.");
    } catch (error) {
        console.error("Failed to start MCP server:", error);
        process.exit(1); // Exit if server fails to start
    }
};

startServer();