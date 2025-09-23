// services/ragService.js
const axios = require('axios');
const config = require('../config/config');
const AIServiceFactory = require('./aiServiceFactory');
const paperlessService = require('./paperlessService');

class RagService {
  constructor() {
    this.baseUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';
  }

  /**
   * Check if the RAG service is available and ready
   * @returns {Promise<{status: string, index_ready: boolean, data_loaded: boolean}>}
   */
  async checkStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/status`);
      //make test call to the LLM service to check if it is available
      return response.data;
    } catch (error) {
      console.error('Error checking RAG service status:', error.message);
      return {
        server_up: false,
        data_loaded: false,
        index_ready: false,
        error: error.message
      };
    }
  }

  /**
   * Search for documents matching a query
   * @param {string} query - The search query
   * @param {Object} filters - Optional filters for search
   * @returns {Promise<Array>} - Array of search results
   */
  async search(query, filters = {}) {
    try {
      const response = await axios.post(`${this.baseUrl}/search`, {
        query,
        ...filters
      });
      return response.data;
    } catch (error) {
      console.error('Error searching documents:', error);
      throw error;
    }
  }

  async askQuestion(question) {
    try {
      // 1. Get context from the RAG service
      const response = await axios.post(`${this.baseUrl}/context`, { 
        question,
        max_sources: 5
      });
      
      const { context, sources } = response.data;
      
      // 2. Check if any source documents have the "Referência" tag and collect metadata
      let hasReferenceTag = false;
      let sourceInfo = '';
      let referenceDocuments = [];
      
      if (sources && sources.length > 0) {
        await paperlessService.ensureTagCache();
        
        for (const source of sources) {
          if (source.doc_id) {
            try {
              const document = await paperlessService.getDocument(source.doc_id);
              if (document.tags && Array.isArray(document.tags)) {
                // Resolve tag names
                const tagNames = document.tags.map(tagId => {
                  const tag = Array.from(paperlessService.tagCache.values()).find(t => t.id === tagId);
                  return tag ? tag.name : null;
                }).filter(name => name);
                
                if (tagNames.includes('Referência')) {
                  hasReferenceTag = true;
                  // Collect detailed metadata for citation
                  referenceDocuments.push({
                    id: source.doc_id,
                    title: document.title || source.title || 'Unknown Title',
                    created: document.created_date || document.created,
                    correspondent: document.correspondent_name || document.correspondent,
                    tags: tagNames,
                    content: document.content ? document.content.substring(0, 500) + '...' : ''
                  });
                }
                
                // Build source info for prompt
                sourceInfo += `Document: ${source.title || 'Document ' + source.doc_id}, Tags: ${tagNames.join(', ')}\n`;
              }
            } catch (error) {
              console.error(`Error fetching document metadata for ${source.doc_id}:`, error.message);
            }
          }
        }
      }
      
      // 3. Fetch full content for each source document using doc_id
      let enhancedContext = context;
      
      if (sources && sources.length > 0) {
        // Fetch full document content for each source
        const fullDocContents = await Promise.all(
          sources.map(async (source) => {
            if (source.doc_id) {
              try {
                const fullContent = await paperlessService.getDocumentContent(source.doc_id);
                return `Full document content for ${source.title || 'Document ' + source.doc_id}:\n${fullContent}`;
              } catch (error) {
                console.error(`Error fetching content for document ${source.doc_id}:`, error.message);
                return '';
              }
            }
            return '';
          })
        );
        
        // Combine original context with full document contents
        enhancedContext = context + '\n\n' + fullDocContents.filter(content => content).join('\n\n');
      }
      
      // 4. Use AI service to generate an answer based on the enhanced context
      const aiService = AIServiceFactory.getService();
      
      // Create a language-agnostic prompt that works in any language
      let citationInstruction = '';
      let referenceInfo = '';
      
      if (hasReferenceTag && referenceDocuments.length > 0) {
        citationInstruction = `- Since some documents have the "Referência" tag, include citations to the sources in your answer using the format <citation>AUTHORS. Title. Journal/Publication. v.Volume, p.Pages, Year.</citation>
        Example: <citation>MADUREIRA, F., COLLEGA, D. G., RODRIGUES, H. F., OLIVEIRA, T. A. C., FREUDENHEIM, A. M. Validação de um Instrumento para Avaliação Qualitativa do Nado "Crawl". Revista Brasileira de Educação Física e Esporte. v.22, p.273-284, 2008.</citation>
        Use the document title and available metadata to format the citation appropriately.`;
        
        referenceInfo = '\n\nReference Documents Metadata:\n' + referenceDocuments.map(doc => 
          `ID: ${doc.id}\nTitle: ${doc.title}\nCreated: ${doc.created}\nCorrespondent: ${doc.correspondent}\nTags: ${doc.tags.join(', ')}\nExcerpt: ${doc.content}`
        ).join('\n\n');
      } else {
        citationInstruction = '- Do not mention document numbers or source references, answer as if it were a natural conversation';
      }
      
      const prompt = `
        You are a helpful assistant that answers questions about documents.

        Answer the following question precisely, based on the provided documents:

        Question: ${question}

        Context from relevant documents:
        ${enhancedContext}

        Source information:
        ${sourceInfo}${referenceInfo}

        Important instructions:
        - Use ONLY information from the provided documents
        - If the answer is not contained in the documents, respond: "This information is not contained in the documents." (in the same language as the question)
        - Avoid assumptions or speculation beyond the given context
        - Answer in the same language as the question was asked
        - Before providing your final answer, double-check that all information comes directly from the documents and is accurate
        - If you're unsure about any part of the answer, either omit it or clearly state the uncertainty
        ${citationInstruction}
        `;

      let answer;
      try {
        answer = await aiService.generateText(prompt);
      } catch (error) {
        console.error('Error generating answer with AI service:', error);
        answer = "An error occurred while generating an answer. Please try again later.";
      }
      
      return {
        answer,
        sources
      };
    } catch (error) {
      console.error('Error in askQuestion:', error);
      throw new Error("An error occurred while processing your question. Please try again later.");
    }
  }

  /**
   * Start indexing documents in the RAG service
   * @param {boolean} force - Whether to force refresh from source
   * @returns {Promise<Object>} - Indexing status
   */
  async indexDocuments(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/start`, { 
        force, 
        background: true 
      });
      return response.data;
    } catch (error) {
      console.error('Error indexing documents:', error);
      throw error;
    }
  }

  /**
   * Check if the RAG service needs document updates
   * @returns {Promise<{needs_update: boolean, message: string}>}
   */
  async checkForUpdates() {
    try {
      const response = await axios.post(`${this.baseUrl}/indexing/check`);
      return response.data;
    } catch (error) {
      console.error('Error checking for updates:', error);
      throw error;
    }
  }

  /**
   * Get current indexing status
   * @returns {Promise<Object>} - Current indexing status
   */
  async getIndexingStatus() {
    try {
      const response = await axios.get(`${this.baseUrl}/indexing/status`);
      return response.data;
    } catch (error) {
      console.error('Error getting indexing status:', error);
      throw error;
    }
  }

  /**
   * Initialize the RAG service
   * @param {boolean} force - Whether to force initialization
   * @returns {Promise<Object>} - Initialization status
   */
  async initialize(force = false) {
    try {
      const response = await axios.post(`${this.baseUrl}/initialize`, { force });
      return response.data;
    } catch (error) {
      console.error('Error initializing RAG service:', error);
      throw error;
    }
  }

  /**
   * Get AI status
   * @returns {Promise<{status: string}>}
   */
  async getAIStatus() {
    try {
      const aiService = AIServiceFactory.getService();
      const status = await aiService.checkStatus();
      return status;
    } catch (error) {
      console.error('Error checking AI service status:', error);
      throw error;
    }
  }
}


module.exports = new RagService();
