// Zustand store for chat state management with AsyncStorage persistence

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { ChatSession, Message, AppConfig } from '../types';

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  config: AppConfig;
  isLoading: boolean;
  hasLoadedFromStorage: boolean;
  storageError: string | null;

  // Actions
  createSession: (title?: string) => string;
  deleteSession: (sessionId: string) => void;
  selectSession: (sessionId: string) => void;
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateConfig: (config: Partial<AppConfig>) => Promise<void>;
  setLoading: (loading: boolean) => void;
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearAllData: () => void;
}

const STORAGE_KEY = '@Terminal221B:store';
const API_KEY_STORAGE_KEY = '@Terminal221B:apiKey';

const persistInBackground = (get: () => ChatStore) => {
  void get()
    .saveToStorage()
    .catch((error) => console.error('Failed to persist chat state:', error));
};

const defaultConfig: AppConfig = {
  apiKey: '',
  model: 'claude-sonnet-4-5-20250929',
  maxTokens: 4096,
  temperature: 1.0,
  systemPrompt: 'You are Claude, a helpful AI assistant.',
};

export const useChatStore = create<ChatStore>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  config: defaultConfig,
  isLoading: false,
  hasLoadedFromStorage: false,
  storageError: null,

  createSession: (title?: string) => {
    const newSession: ChatSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      title: title || `Chat ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };

    set((state) => ({
      sessions: [newSession, ...state.sessions],
      currentSessionId: newSession.id,
    }));

    // Auto-save after creating session
    persistInBackground(get);

    return newSession.id;
  },

  deleteSession: (sessionId: string) => {
    set((state) => {
      const updatedSessions = state.sessions.filter((s) => s.id !== sessionId);
      const newCurrentId =
        state.currentSessionId === sessionId
          ? updatedSessions[0]?.id || null
          : state.currentSessionId;

      return {
        sessions: updatedSessions,
        currentSessionId: newCurrentId,
      };
    });

    persistInBackground(get);
  },

  selectSession: (sessionId: string) => {
    set({ currentSessionId: sessionId });
  },

  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => {
    const newMessage: Message = {
      ...message,
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };

    set((state) => {
      const sessions = state.sessions.map((session) => {
        if (session.id === newMessage.sessionId) {
          return {
            ...session,
            messages: [...session.messages, newMessage],
            updatedAt: Date.now(),
          };
        }
        return session;
      });

      return { sessions };
    });

    persistInBackground(get);
  },

  updateSessionTitle: (sessionId: string, title: string) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, title, updatedAt: Date.now() }
          : session
      ),
    }));

    persistInBackground(get);
  },

  updateConfig: async (newConfig: Partial<AppConfig>) => {
    if (Platform.OS !== 'web' && newConfig.apiKey !== undefined) {
      const apiKey = newConfig.apiKey.trim();
      if (apiKey) {
        await SecureStore.setItemAsync(API_KEY_STORAGE_KEY, apiKey);
      } else {
        await SecureStore.deleteItemAsync(API_KEY_STORAGE_KEY);
      }
    }

    set((state) => ({
      config: { ...state.config, ...newConfig },
    }));

    await get().saveToStorage();
    set({ storageError: null });
  },

  setLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },

  loadFromStorage: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : {};
      const storedConfig = parsed.config || {};
      const legacyApiKey =
        typeof storedConfig.apiKey === 'string' ? storedConfig.apiKey : '';
      let apiKey = '';
      let canRewriteStorage = true;

      if (Platform.OS !== 'web') {
        try {
          const secureApiKey = await SecureStore.getItemAsync(
            API_KEY_STORAGE_KEY
          );
          apiKey = secureApiKey || legacyApiKey;
          if (legacyApiKey && !secureApiKey) {
            await SecureStore.setItemAsync(API_KEY_STORAGE_KEY, legacyApiKey);
          }
        } catch (error) {
          console.error('Failed to load API key from secure storage:', error);
          apiKey = legacyApiKey;
          canRewriteStorage = false;
        }
      }

      set({
        sessions: parsed.sessions || [],
        currentSessionId: parsed.currentSessionId || null,
        config: { ...defaultConfig, ...storedConfig, apiKey },
        storageError: null,
      });
      if (canRewriteStorage) {
        await get().saveToStorage();
      } else {
        set({
          storageError:
            'Could not access secure storage. Any saved API key could not be verified or migrated; existing storage was left unchanged. Retry in Settings after secure storage is available.',
        });
      }
    } catch (error) {
      console.error('Failed to load from storage:', error);
      set({ storageError: 'Unable to load or migrate saved chat data.' });
    } finally {
      set({ hasLoadedFromStorage: true });
    }
  },

  saveToStorage: async () => {
    const { sessions, currentSessionId, config } = get();
    const { apiKey: _apiKey, ...persistedConfig } = config;
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        sessions,
        currentSessionId,
        config: persistedConfig,
      })
    );
  },

  clearAllData: () => {
    set({
      sessions: [],
      currentSessionId: null,
      config: defaultConfig,
      storageError: null,
    });

    AsyncStorage.removeItem(STORAGE_KEY).catch((error) => {
      console.error('Failed to clear stored chat data:', error);
    });
    if (Platform.OS !== 'web') {
      SecureStore.deleteItemAsync(API_KEY_STORAGE_KEY).catch((error) => {
        console.error('Failed to clear the stored API key:', error);
      });
    }
  },
}));
