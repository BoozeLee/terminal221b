import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { asyncStorage, secureStore } = vi.hoisted(() => ({
  asyncStorage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  secureStore: {
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorage,
}));
vi.mock('expo-secure-store', () => secureStore);
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

import { useChatStore } from './chatStore';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('chatStore API key persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState(useChatStore.getInitialState(), true);
    asyncStorage.getItem.mockResolvedValue(null);
    asyncStorage.setItem.mockResolvedValue(undefined);
    asyncStorage.removeItem.mockResolvedValue(undefined);
    secureStore.getItemAsync.mockResolvedValue(null);
    secureStore.setItemAsync.mockResolvedValue(undefined);
    secureStore.deleteItemAsync.mockResolvedValue(undefined);
  });

  it('stores native API keys in SecureStore but not AsyncStorage', async () => {
    await useChatStore.getState().updateConfig({ apiKey: 'test-key' });

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      '@Terminal221B:apiKey',
      'test-key'
    );
    const persisted = JSON.parse(asyncStorage.setItem.mock.calls[0][1]);
    expect(persisted.config).not.toHaveProperty('apiKey');
    expect(useChatStore.getState().config.apiKey).toBe('test-key');
  });

  it('migrates a legacy key before removing it from AsyncStorage', async () => {
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({
        sessions: [],
        currentSessionId: null,
        config: { apiKey: 'legacy-key' },
      })
    );

    await useChatStore.getState().loadFromStorage();

    expect(secureStore.setItemAsync).toHaveBeenCalledWith(
      '@Terminal221B:apiKey',
      'legacy-key'
    );
    const persisted = JSON.parse(asyncStorage.setItem.mock.calls[0][1]);
    expect(persisted.config).not.toHaveProperty('apiKey');
    expect(useChatStore.getState().config.apiKey).toBe('legacy-key');
  });

  it('preserves the legacy key and reports an error if secure migration fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    asyncStorage.getItem.mockResolvedValue(
      JSON.stringify({
        sessions: [],
        currentSessionId: null,
        config: { apiKey: 'legacy-key' },
      })
    );
    secureStore.getItemAsync.mockRejectedValue(
      new Error('SecureStore unavailable')
    );

    await useChatStore.getState().loadFromStorage();

    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(useChatStore.getState().config.apiKey).toBe('legacy-key');
    expect(useChatStore.getState().storageError).toContain(
      'Could not access secure storage'
    );
  });
});
