// Zustand store for chat state management with AsyncStorage persistence

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ChatSession, Message, AppConfig } from '../types';

interface ChatStore {
  sessions: ChatSession[];
  currentSessionId: string | null;
  config: AppConfig;
  isLoading: boolean;

  // Actions
  createSession: (title?: string) => string;
  deleteSession: (sessionId: string) => void;
  selectSession: (sessionId: string) => void;
  addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateConfig: (config: Partial<AppConfig>) => void;
  setLoading: (loading: boolean) => void;
  loadFromStorage: () => Promise<void>;
  saveToStorage: () => Promise<void>;
  clearAllData: () => void;
}

const STORAGE_KEY = '@Terminal221B:store';

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
    get().saveToStorage();

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

    get().saveToStorage();
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

    get().saveToStorage();
  },

  updateSessionTitle: (sessionId: string, title: string) => {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, title, updatedAt: Date.now() }
          : session
      ),
    }));

    get().saveToStorage();
  },

  updateConfig: (newConfig: Partial<AppConfig>) => {
    set((state) => ({
      config: { ...state.config, ...newConfig },
    }));

    get().saveToStorage();
  },

  setLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },

  loadFromStorage: async () => {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        set({
          sessions: parsed.sessions || [],
          currentSessionId: parsed.currentSessionId || null,
          config: { ...defaultConfig, ...parsed.config },
        });
      }
    } catch (error) {
      console.error('Failed to load from storage:', error);
    }
  },

  saveToStorage: async () => {
    try {
      const { sessions, currentSessionId, config } = get();
      await AsyncStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sessions,
          currentSessionId,
          config,
        })
      );
    } catch (error) {
      console.error('Failed to save to storage:', error);
    }
  },

  clearAllData: () => {
    set({
      sessions: [],
      currentSessionId: null,
      config: defaultConfig,
    });

    AsyncStorage.removeItem(STORAGE_KEY);
  },
}));
