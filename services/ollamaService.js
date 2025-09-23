const {
    calculateTokens,
    calculateTotalPromptTokens,
    truncateToTokenLimit,
    writePromptToFile
} = require('./serviceUtils');
const axios = require('axios');
const config = require('../config/config');
const fs = require('fs').promises;
const path = require('path');
const paperlessService = require('./paperlessService');
const os = require('os');
const OpenAI = require('openai');
const RestrictionPromptService = require('./restrictionPromptService');

/**
 * Service for document analysis using Ollama
 */
class OllamaService {
    /**
     * Initialize the Ollama service
     */
    constructor() {
        this.apiUrl = config.ollama.apiUrl;
        this.model = config.ollama.model;
        this.client = axios.create({
            timeout: 1800000 // 30 minutes timeout
        });

        // JSON schema for document analysis output
        this.documentAnalysisSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" },
                custom_fields: {
                    type: "object",
                    additionalProperties: true
                }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };

        // Schema for playground analysis (simpler version)
        this.playgroundSchema = {
            type: "object",
            properties: {
                title: { type: "string" },
                correspondent: { type: "string" },
                tags: {
                    type: "array",
                    items: { type: "string" }
                },
                document_type: { type: "string" },
                document_date: { type: "string" },
                language: { type: "string" }
            },
            required: ["title", "correspondent", "tags", "document_type", "document_date", "language"]
        };
    }

    /**
     * Analyze a document and extract metadata
     * @param {string} content - Document content
     * @param {Array} existingTags - List of existing tags
     * @param {Array} existingCorrespondentList - List of existing correspondents
     * @param {string} id - Document ID
     * @param {string} customPrompt - Custom prompt (optional)
     * @returns {Object} Analysis results
     */
    async analyzeDocument(content, existingTags = [], existingCorrespondentList = [], existingDocumentTypesList = [], id, customPrompt = null, options = {}) {
        try {
            // Truncate content if needed
            content = this._truncateContent(content);

            // Cache thumbnail
            await this._handleThumbnailCaching(id);

            // Get external API data if available and validate it
            let externalApiData = options.externalApiData || null;
            let validatedExternalApiData = null;

            if (externalApiData) {
                try {
                    validatedExternalApiData = await this._validateAndTruncateExternalApiData(externalApiData);
                    console.log('[DEBUG] External API data validated and included');
                } catch (error) {
                    console.warn('[WARNING] External API data validation failed:', error.message);
                    validatedExternalApiData = null;
                }
            }

            // Build prompt
            let prompt;
            if (!customPrompt) {
                prompt = this._buildPrompt(content, existingTags, existingCorrespondentList, existingDocumentTypesList, options);
            } else {
                // Parse CUSTOM_FIELDS for custom prompt
                let customFieldsObj;
                try {
                    customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
                } catch (error) {
                    console.error('Failed to parse CUSTOM_FIELDS:', error);
                    customFieldsObj = { custom_fields: [] };
                }

                const customFieldsTemplate = {};
                customFieldsObj.custom_fields.forEach((field, index) => {
                    customFieldsTemplate[index] = {
                        field_name: field.value,
                        value: "Fill in the value based on your analysis"
                    };
                });

                const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
                    .split('\n')
                    .map(line => '    ' + line)
                    .join('\n');

                prompt = customPrompt + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr) + "\n\n" + JSON.stringify(content);
                console.log('[DEBUG] Ollama Service started with custom prompt');
            }

            // Generate custom fields for the prompt
            const customFieldsStr = this._generateCustomFieldsTemplate();

            // Generate system prompt
            const systemPrompt = this._generateSystemPrompt(customFieldsStr);

            // Calculate context window size
            const promptTokenCount = this._calculatePromptTokenCount(prompt);
            const numCtx = this._calculateNumCtx(promptTokenCount, 1024);

            console.log(`[DEBUG] Use existing data: ${config.useExistingData}, Restrictions applied based on useExistingData setting`);
            console.log(`[DEBUG] External API data: ${validatedExternalApiData ? 'included' : 'none'}`);

            // Call Ollama API
            const response = await this._callOllamaAPI(prompt, systemPrompt, numCtx, this.documentAnalysisSchema);

            // Process response
            const parsedResponse = this._processOllamaResponse(response);

            // Check for missing data
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.');
            }

            // Log the prompt and response
            await this._logPromptAndResponse(prompt, parsedResponse);

            // Return results in consistent format
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,  // Ollama doesn't provide token metrics
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: false
            };
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    /**
     * Analyze a document in playground mode
     * @param {string} content - Document content
     * @param {string} prompt - User-provided prompt
     * @returns {Object} Analysis results
     */
    async analyzePlayground(content, prompt) {
        try {
            // Calculate context window size
            const promptTokenCount = await calculateTokens(prompt);
            const numCtx = this._calculateNumCtx(promptTokenCount, 1024);

            // Generate playground system prompt (simpler than full analysis)
            const systemPrompt = this._generatePlaygroundSystemPrompt();

            // Call Ollama API
            const response = await this._callOllamaAPI(
                prompt + "\n\n" + JSON.stringify(content),
                systemPrompt,
                numCtx,
                this.playgroundSchema
            );

            // Process response
            const parsedResponse = this._processOllamaResponse(response);

            // Check for missing data
            if (parsedResponse.tags.length === 0 && parsedResponse.correspondent === null) {
                console.warn('No tags or correspondent found in response from Ollama for Document. Please review your prompt or switch to OpenAI for better results.');
            }

            // Return results in consistent format
            return {
                document: parsedResponse,
                metrics: {
                    promptTokens: 0,
                    completionTokens: 0,
                    totalTokens: 0
                },
                truncated: false
            };
        } catch (error) {
            console.error('Error analyzing document with Ollama:', error);
            return {
                document: { tags: [], correspondent: null },
                metrics: null,
                error: error.message
            };
        }
    }

    /**
     * Truncate content to maximum length if specified
     * @param {string} content - Content to truncate
     * @returns {string} Truncated content
     */
    _truncateContent(content) {
        try {
            if (process.env.CONTENT_MAX_LENGTH) {
                console.log('Truncating content to max length:', process.env.CONTENT_MAX_LENGTH);
                return content.substring(0, process.env.CONTENT_MAX_LENGTH);
            }
        } catch (error) {
            console.error('Error truncating content:', error);
        }
        return content;
    }

    /**
     * Build prompt from content and existing data
     * @param {string} content - Document content
     * @param {Array} existingTags - List of existing tags
     * @param {Array} existingCorrespondent - List of existing correspondents
     * @param {Array} existingDocumentTypes - List of existing document types
     * @returns {string} Formatted prompt
     */
    _buildPrompt(content, existingTags = [], existingCorrespondent = [], existingDocumentTypes = [], options = {}) {
        let systemPrompt;
        let promptTags = '';

        // Validate that existingCorrespondent is an array and handle if it's not
        const correspondentList = Array.isArray(existingCorrespondent)
            ? existingCorrespondent
            : [];

        // Parse CUSTOM_FIELDS from environment variable
        let customFieldsObj;
        try {
            customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
            console.error('Failed to parse CUSTOM_FIELDS:', error);
            customFieldsObj = { custom_fields: [] };
        }

        // Generate custom fields template for the prompt
        const customFieldsTemplate = {};

        customFieldsObj.custom_fields.forEach((field, index) => {
            customFieldsTemplate[index] = {
                field_name: field.value,
                value: "Fill in the value based on your analysis"
            };
        });

        // Convert template to string for replacement and wrap in custom_fields
        const customFieldsStr = '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
            .split('\n')
            .map(line => '    ' + line)  // Add proper indentation
            .join('\n');

        // Get system prompt based on configuration
        if (config.useExistingData === 'yes' && config.restrictToExistingTags === 'no' && config.restrictToExistingCorrespondents === 'no') {
            // Format existing tags
            const existingTagsList = existingTags.join(', ');

            // Format existing correspondents - handle both array of objects and array of strings
            const existingCorrespondentList = correspondentList
                .filter(Boolean)  // Remove any null/undefined entries
                .map(correspondent => {
                    if (typeof correspondent === 'string') return correspondent;
                    return correspondent?.name || '';
                })
                .filter(name => name.length > 0)  // Remove empty strings
                .join(', ');

            // Format existing document types - handle both array of objects and array of strings
            const existingDocumentTypesList = existingDocumentTypes
                .filter(Boolean)  // Remove any null/undefined entries
                .map(docType => {
                    if (typeof docType === 'string') return docType;
                    return docType?.name || '';
                })
                .filter(name => name.length > 0)  // Remove empty strings
                .join(', ');

            systemPrompt = `
            Pre-existing tags: ${existingTagsList}\n\n
            Pre-existing correspondents: ${existingCorrespondentList}\n\n
            Pre-existing document types: ${existingDocumentTypesList}\n\n
            ` + process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
            promptTags = '';
        } else {
            config.mustHavePrompt = config.mustHavePrompt.replace('%CUSTOMFIELDS%', customFieldsStr);
            systemPrompt = process.env.SYSTEM_PROMPT + '\n\n' + config.mustHavePrompt;
            promptTags = '';
        }

        // Get validated external API data if available
        let validatedExternalApiData = null;
        if (options.externalApiData) {
            try {
                validatedExternalApiData = this._validateAndTruncateExternalApiData(options.externalApiData);
                console.log('[DEBUG] External API data validated and included');
            } catch (error) {
                console.warn('[WARNING] External API data validation failed:', error.message);
                validatedExternalApiData = null;
            }
        }

        // Process placeholder replacements in system prompt
        systemPrompt = RestrictionPromptService.processRestrictionsInPrompt(
            systemPrompt,
            existingTags,
            correspondentList,
            existingDocumentTypes,
            config
        );

        // Include validated external API data if available
        if (validatedExternalApiData) {
            systemPrompt += `\n\nAdditional context from external API:\n${validatedExternalApiData}`;
        }

        if (process.env.USE_PROMPT_TAGS === 'yes') {
            promptTags = process.env.PROMPT_TAGS;
            systemPrompt = `
            Take these tags and try to match one or more to the document content.\n\n
            ` + config.specialPromptPreDefinedTags;
        }

        return `${systemPrompt}
        ${JSON.stringify(content)}
        `;
    }

    /**
     * Validate and truncate external API data to prevent token overflow
     * @param {any} apiData - The external API data to validate
     * @param {number} maxTokens - Maximum tokens allowed for external data (default: 500)
     * @returns {string} - Validated and potentially truncated data string
     */
    async _validateAndTruncateExternalApiData(apiData, maxTokens = 500) {
        if (!apiData) {
            return null;
        }

        const dataString = typeof apiData === 'object'
            ? JSON.stringify(apiData, null, 2)
            : String(apiData);

        // Calculate tokens for the data (using simple estimation for Ollama)
        const dataTokens = Math.ceil(dataString.length / 4);

        if (dataTokens > maxTokens) {
            console.warn(`[WARNING] External API data (${dataTokens} tokens) exceeds limit (${maxTokens}), truncating`);
            // Simple truncation based on character count
            const maxChars = maxTokens * 4;
            return dataString.substring(0, maxChars);
        }

        console.log(`[DEBUG] External API data validated: ${dataTokens} tokens`);
        return dataString;
    }

    /**
     * Generate custom fields template for prompts
     * @returns {string} Custom fields template as a string
     */
    _generateCustomFieldsTemplate() {
        let customFieldsObj;
        try {
            customFieldsObj = JSON.parse(process.env.CUSTOM_FIELDS);
        } catch (error) {
            console.error('Failed to parse CUSTOM_FIELDS:', error);
            customFieldsObj = { custom_fields: [] };
        }

        // Generate custom fields template for the prompt
        const customFieldsTemplate = {};

        customFieldsObj.custom_fields.forEach((field, index) => {
            customFieldsTemplate[index] = {
                field_name: field.value,
                value: "Fill in the value based on your analysis"
            };
        });

        // Convert template to string for replacement and wrap in custom_fields
        return '"custom_fields": ' + JSON.stringify(customFieldsTemplate, null, 2)
            .split('\n')
            .map(line => '    ' + line)  // Add proper indentation
            .join('\n');
    }

    /**
     * Generate system prompt for document analysis
     * @param {string} customFieldsStr - Custom fields as a string
     * @returns {string} System prompt
     */
    _generateSystemPrompt(customFieldsStr) {
        let systemPromptTemplate = `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Return the result EXCLUSIVELY as a JSON object. The Tags, Title and Document_Type MUST be in the language that is used in the document.:
            IMPORTANT: The custom_fields are optional and can be left out if not needed, only try to fill out the values if you find a matching information in the document.
            Do not change the value of field_name, only fill out the values. If the field is about money only add the number without currency and always use a . for decimal places.
            {
                "title": "xxxxx",
                "correspondent": "xxxxxxxx",
                "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
                "document_type": "Invoice/Contract/...",
                "document_date": "YYYY-MM-DD",
                "language": "en/de/es/...",
                %CUSTOMFIELDS%
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;

        return systemPromptTemplate.replace('%CUSTOMFIELDS%', customFieldsStr);
    }

    /**
     * Generate system prompt for playground analysis
     * @returns {string} System prompt
     */
    _generatePlaygroundSystemPrompt() {
        return `
            You are a document analyzer. Your task is to analyze documents and extract relevant information. You do not ask back questions. 
            YOU MUSTNOT: Ask for additional information or clarification, or ask questions about the document, or ask for additional context.
            YOU MUSTNOT: Return a response without the desired JSON format.
            YOU MUST: Analyze the document content and extract the following information into this structured JSON format and only this format!:         {
            "title": "xxxxx",
            "correspondent": "xxxxxxxx",
            "tags": ["Tag1", "Tag2", "Tag3", "Tag4"],
            "document_type": "Invoice/Contract/...",
            "document_date": "YYYY-MM-DD",
            "language": "en/de/es/..."
            }
            ALWAYS USE THE INFORMATION TO FILL OUT THE JSON OBJECT. DO NOT ASK BACK QUESTIONS.
        `;
    }

    /**
     * Calculate prompt token count
     * @param {string} prompt - Prompt text
     * @returns {number} Estimated token count
     */
    _calculatePromptTokenCount(prompt) {
        return Math.ceil(prompt.length / 4);
    }

    /**
     * Calculate context window size for Ollama
     * @param {number} promptTokenCount - Token count for prompt
     * @param {number} expectedResponseTokens - Expected response token count
     * @returns {number} Context window size
     */
    _calculateNumCtx(promptTokenCount, expectedResponseTokens) {
        const totalTokenUsage = promptTokenCount + expectedResponseTokens;
        const maxCtxLimit = Number(config.tokenLimit);

        const numCtx = Math.min(totalTokenUsage, maxCtxLimit);

        console.log('Prompt Token Count:', promptTokenCount);
        console.log('Expected Response Tokens:', expectedResponseTokens);
        console.log('Dynamic calculated num_ctx:', numCtx);

        return numCtx;
    }

    /**
     * Get available system memory
     * @returns {Object} Object with totalMemoryMB and freeMemoryMB
     */
    async _getAvailableMemory() {
        const totalMemory = os.totalmem();
        const freeMemory = os.freemem();
        const totalMemoryMB = (totalMemory / (1024 * 1024)).toFixed(0);
        const freeMemoryMB = (freeMemory / (1024 * 1024)).toFixed(0);
        return { totalMemoryMB, freeMemoryMB };
    }

    /**
     * Handle thumbnail caching for documents
     * @param {string} id - Document ID
     */
    async _handleThumbnailCaching(id) {
        if (!id) return;

        const cachePath = path.join('./public/images', `${id}.png`);
        try {
            await fs.access(cachePath);
            console.log('[DEBUG] Thumbnail already cached');
        } catch (err) {
            console.log('Thumbnail not cached, fetching from Paperless');
            const thumbnailData = await paperlessService.getThumbnailImage(id);
            if (!thumbnailData) {
                console.warn('Thumbnail nicht gefunden');
                return;
            }
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, thumbnailData);
        }
    }

    /**
     * Call Ollama API
     * @param {string} prompt - Prompt text
     * @param {string} systemPrompt - System prompt
     * @param {number} numCtx - Context window size
     * @param {Object} schema - Response schema
     * @returns {Object} Ollama API response
     */
    async _callOllamaAPI(prompt, systemPrompt, numCtx, schema) {
        const response = await this.client.post(`${this.apiUrl}/api/generate`, {
            model: this.model,
            prompt: prompt,
            system: systemPrompt,
            stream: false,
            format: schema,
            options: {
                temperature: 0.7,
                top_p: 0.9,
                repeat_penalty: 1.1,
                top_k: 7,
                num_predict: 256,
                num_ctx: numCtx
            }
        });

        if (!response.data) {
            throw new Error('Invalid response from Ollama API');
        }

        return response.data;
    }

    /**
     * Process Ollama API response
     * @param {Object} responseData - Ollama API response data
     * @returns {Object} Parsed response
     */
    _processOllamaResponse(responseData) {
        // Check if we got a structured response or need to parse from text
        if (responseData.response && typeof responseData.response === 'object') {
            // We got a structured response directly
            console.log('Using structured output response');
            return {
                tags: Array.isArray(responseData.response.tags) ? responseData.response.tags : [],
                correspondent: responseData.response.correspondent || null,
                title: responseData.response.title || null,
                document_date: responseData.response.document_date || null,
                document_type: responseData.response.document_type || null,
                language: responseData.response.language || null,
                custom_fields: responseData.response.custom_fields || null
            };
        } else if (responseData.response) {
            // Fall back to parsing from text response
            console.log('Falling back to text response parsing');
            return this._parseResponse(responseData.response);
        } else {
            throw new Error('No response data from Ollama API');
        }
    }

    /**
     * Parse text response to extract JSON
     * @param {string} response - Response text
     * @returns {Object} Parsed object
     */
    _parseResponse(response) {
        try {
            // Find JSON in response using regex
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                return { tags: [], correspondent: null };
            }

            let jsonStr = jsonMatch[0];
            console.log('Extracted JSON String:', jsonStr);

            try {
                // Attempt to parse the JSON
                const result = JSON.parse(jsonStr);

                // Validate and return the result
                return {
                    tags: Array.isArray(result.tags) ? result.tags : [],
                    correspondent: result.correspondent || null,
                    title: result.title || null,
                    document_date: result.document_date || null,
                    document_type: result.document_type || null,
                    language: result.language || null,
                    custom_fields: result.custom_fields || null
                };

            } catch (jsonError) {
                console.warn('Error parsing JSON from response:', jsonError.message);
                console.warn('Attempting to sanitize the JSON...');

                // Sanitize the JSON
                jsonStr = this._sanitizeJsonString(jsonStr);

                try {
                    const sanitizedResult = JSON.parse(jsonStr);
                    return {
                        tags: Array.isArray(sanitizedResult.tags) ? sanitizedResult.tags : [],
                        correspondent: sanitizedResult.correspondent || null,
                        title: sanitizedResult.title || null,
                        document_date: sanitizedResult.document_date || null,
                        language: sanitizedResult.language || null
                    };
                } catch (finalError) {
                    console.error('Final JSON parsing failed after sanitization. This happens when the JSON structure is too complex or invalid. That indicates an issue with the generated JSON string by Ollama. Switch to OpenAI for better results or fine tune your prompt.');
                    return { tags: [], correspondent: null };
                }
            }
        } catch (error) {
            console.error('Error parsing Ollama response:', error.message);
            return { tags: [], correspondent: null };
        }
    }

    /**
     * Sanitize a JSON string
     * @param {string} jsonStr - JSON string to sanitize
     * @returns {string} Sanitized JSON string
     */
    _sanitizeJsonString(jsonStr) {
        return jsonStr
            .replace(/,\s*}/g, '}') // Remove trailing commas before closing braces
            .replace(/,\s*]/g, ']') // Remove trailing commas before closing brackets
            .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":'); // Ensure property names are quoted
    }

    /**
     * Log prompt and response to file
     * @param {string} prompt - Prompt text
     * @param {Object} response - Response object
     */
    async _logPromptAndResponse(prompt, response) {
        const content = '================================================================================'
            + prompt + "\n\n"
            + JSON.stringify(response)
            + '\n\n'
            + '================================================================================\n\n';

        await writePromptToFile(content);
    }

    /**
     * Generate text based on a prompt
     * @param {string} prompt - The prompt to generate text from
     * @returns {Promise<string>} - The generated text
     */
    async generateText(prompt, options = {}) {
        try {
            // Calculate context window size based on prompt length
            const promptTokenCount = this._calculatePromptTokenCount(prompt);
            const numCtx = this._calculateNumCtx(promptTokenCount, 512);

            // Simple system prompt for text generation
            const systemPrompt = `You are a helpful assistant. Generate a clear, concise, and informative response to the user's question or request.`;

            const temperature = options.temperature || parseFloat(process.env.RAG_TEMPERATURE) || 0.1;

            // Call Ollama API without enforcing a specific response format
            const response = await this.client.post(`${this.apiUrl}/api/generate`, {
                model: this.model,
                prompt: prompt,
                system: systemPrompt,
                stream: false,
                options: {
                    temperature: temperature,
                    top_p: 0.9,
                    num_predict: 1024,
                    num_ctx: numCtx
                }
            });

            if (!response.data || !response.data.response) {
                throw new Error('Invalid response from Ollama API');
            }

            return response.data.response;
        } catch (error) {
            console.error('Error generating text with Ollama:', error);
            throw error;
        }
    }

    /**
     * Check if the Ollama service is running
     * @returns {Promise<boolean>} - True if the service is running, false otherwise
     */
    async checkStatus() {
        // use ollama status endpoint
        try {
            const response = await this.client.get(`${this.apiUrl}/api/ps`);
            if (response.status === 200) {
                const data = response.data;
                // Ensure data is an array and has at least one model
                let modelName = null;
                if (Array.isArray(data.models) && data.models.length > 0) {
                    modelName = data.models[0].name;
                }
                console.log('Ollama model name:', modelName);
                return { status: 'ok', model: modelName };
            }
        } catch (error) {
            console.error('Error checking Ollama service status:', error);
        }
        return { status: 'error' };
    }
}

module.exports = new OllamaService();
