// Chat Screen Component with dark theme

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useChatStore } from '../../store/chatStore';
import { ClaudeService } from '../../services/api/ClaudeService';
import { Message } from '../../types';

export const ChatScreen: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const flatListRef = useRef<FlatList>(null);

  const {
    sessions,
    currentSessionId,
    config,
    isLoading,
    addMessage,
    createSession,
    setLoading,
  } = useChatStore();

  const currentSession = sessions.find((s) => s.id === currentSessionId);

  useEffect(() => {
    // Create initial session if none exists
    if (sessions.length === 0) {
      createSession('New Chat');
    }
  }, []);

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    if (currentSession?.messages.length) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [currentSession?.messages.length]);

  const handleSend = async () => {
    if (!inputText.trim() || isLoading) return;

    if (!config.apiKey) {
      Alert.alert(
        'API Key Required',
        'Please set your Anthropic API key in Settings'
      );
      return;
    }

    if (!currentSessionId) {
      const newSessionId = createSession();
      // Wait a bit for state to update
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const userMessage = inputText.trim();
    setInputText('');

    // Add user message
    addMessage({
      role: 'user',
      content: userMessage,
      sessionId: currentSessionId!,
    });

    setLoading(true);

    try {
      // Get conversation history
      const conversationMessages = currentSession?.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
      })) || [];

      // Add current user message
      conversationMessages.push({
        role: 'user',
        content: userMessage,
      });

      // Call Claude API
      const response = await ClaudeService.sendMessage({
        apiKey: config.apiKey,
        messages: conversationMessages,
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        systemPrompt: config.systemPrompt,
      });

      // Add assistant response
      addMessage({
        role: 'assistant',
        content: response,
        sessionId: currentSessionId!,
      });
    } catch (error) {
      Alert.alert(
        'Error',
        error instanceof Error ? error.message : 'Failed to send message'
      );
    } finally {
      setLoading(false);
    }
  };

  const renderMessage = ({ item }: { item: Message }) => (
    <View
      style={[
        styles.messageContainer,
        item.role === 'user' ? styles.userMessage : styles.assistantMessage,
      ]}
    >
      <Text style={styles.messageRole}>
        {item.role === 'user' ? 'You' : 'Claude'}
      </Text>
      <Text style={styles.messageText}>{item.content}</Text>
      <Text style={styles.messageTime}>
        {new Date(item.timestamp).toLocaleTimeString()}
      </Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          {currentSession?.title || 'Terminal 221B'}
        </Text>
        <Text style={styles.headerSubtitle}>
          {config.model.replace('claude-', '')}
        </Text>
      </View>

      {/* Messages List */}
      <FlatList
        ref={flatListRef}
        data={currentSession?.messages || []}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messagesList}
        onContentSizeChange={() =>
          flatListRef.current?.scrollToEnd({ animated: true })
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateText}>
              Start a conversation with Claude
            </Text>
            <Text style={styles.emptyStateSubtext}>
              Type a message below to begin
            </Text>
          </View>
        }
      />

      {/* Input Area */}
      <View style={styles.inputContainer}>
        {isLoading && (
          <ActivityIndicator
            size="small"
            color="#8B5CF6"
            style={styles.loadingIndicator}
          />
        )}
        <TextInput
          style={styles.input}
          placeholder="Message Claude..."
          placeholderTextColor="#6B7280"
          value={inputText}
          onChangeText={setInputText}
          multiline
          maxLength={10000}
          editable={!isLoading}
          onSubmitEditing={handleSend}
        />
        <TouchableOpacity
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!inputText.trim() || isLoading}
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F1419',
  },
  header: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1F2937',
    backgroundColor: '#111827',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 2,
  },
  messagesList: {
    padding: 16,
    flexGrow: 1,
  },
  messageContainer: {
    marginBottom: 16,
    padding: 12,
    borderRadius: 12,
    maxWidth: '85%',
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#8B5CF6',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#1F2937',
  },
  messageRole: {
    fontSize: 12,
    fontWeight: '600',
    color: '#E5E7EB',
    marginBottom: 4,
  },
  messageText: {
    fontSize: 16,
    color: '#FFFFFF',
    lineHeight: 22,
  },
  messageTime: {
    fontSize: 10,
    color: '#9CA3AF',
    marginTop: 4,
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#1F2937',
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  loadingIndicator: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#1F2937',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    color: '#FFFFFF',
    maxHeight: 100,
  },
  sendButton: {
    marginLeft: 8,
    backgroundColor: '#8B5CF6',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyStateText: {
    fontSize: 18,
    color: '#E5E7EB',
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyStateSubtext: {
    fontSize: 14,
    color: '#9CA3AF',
  },
});
