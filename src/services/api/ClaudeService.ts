// Claude API Service - Pure fetch implementation for web/mobile compatibility

import { ApiResponse, ApiError, MessageContent } from '../../types';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

export interface SendMessageParams {
  apiKey: string;
  messages: MessageContent[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export class ClaudeService {
  /**
   * Send a message to Claude API
   */
  static async sendMessage(params: SendMessageParams): Promise<string> {
    const {
      apiKey,
      messages,
      model = 'claude-sonnet-4-5-20250929',
      maxTokens = 4096,
      temperature = 1.0,
      systemPrompt,
    } = params;

    if (!apiKey) {
      throw new Error('API key is required');
    }

    if (messages.length === 0) {
      throw new Error('At least one message is required');
    }

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature,
          ...(systemPrompt && { system: systemPrompt }),
          messages: messages.map((msg) => ({
            role: msg.role,
            content: msg.content,
          })),
        }),
      });

      if (!response.ok) {
        const errorData: ApiError = await response.json();
        throw new Error(
          errorData.error?.message || `API Error: ${response.statusText}`
        );
      }

      const data: ApiResponse = await response.json();

      // Extract text content from response
      const textContent = data.content.find((c) => c.type === 'text');
      if (!textContent) {
        throw new Error('No text content in API response');
      }

      return textContent.text;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Failed to send message to Claude API');
    }
  }

  /**
   * Validate API key by making a test request
   */
  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      await this.sendMessage({
        apiKey,
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get list of available models
   */
  static getAvailableModels(): Array<{ id: string; name: string; description: string }> {
    return [
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        description: 'Most capable model, best for complex tasks',
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        description: 'Balanced performance and speed (recommended)',
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        description: 'Fastest model for quick responses',
      },
    ];
  }
}
