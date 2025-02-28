/** @odoo-module **/

import { registry } from "@web/core/registry";
import { Component, onWillStart, onMounted, onWillUnmount, useRef, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { formatDateTime, deserializeDateTime } from "@web/core/l10n/dates";
import { Pager } from "@web/core/pager/pager";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";

class WhatsAppChat extends Component {
    setup() {
        this.rpc = useService("rpc");
        this.user = useService("user");
        this.dialogService = useService("dialog");
        
        // initialize refs
        this.messageContainerRef = useRef("messageContainer");
        this.messageInputRef = useRef("messageInput");
        this.fileInputRef = useRef("fileInput");
        this.searchInputRef = useRef("searchInput");
        this.voiceRecorderRef = useRef("voiceRecorder");
        this.audioContext = null;
        this.mediaRecorder = null;
        this.audioChunks = [];

        // format message helper
        this.formatMessageBody = (body) => {
            if (!body) return '';
            
            // remove html tag
            let cleanBody = body.replace(/<[^>]*>/g, '');
            
            // replace html entities
            cleanBody = cleanBody.replace(/&lt;/g, '<')
                                .replace(/&gt;/g, '>')
                                .replace(/&nbsp;/g, ' ')
                                .replace(/&amp;/g, '&');
            
            return cleanBody.trim();
        };

        this.formatDateTimeField = (value) => {
            if (!value) return '';
            try {
                // convert the date string to utc date object
                const date = new Date(value.replace(' ', 'T') + 'Z');
                
                // get the raw hours and minutes
                const hours = date.getUTCHours();
                const minutes = date.getUTCMinutes();
                
                // add 3 hours for kuwait time
                const kuwaitHours = (hours + 3) % 24;
                
                // format in 12hour format
                const ampm = kuwaitHours >= 12 ? 'PM' : 'AM';
                const formattedHours = kuwaitHours % 12 || 12;
                const formattedMinutes = minutes.toString().padStart(2, '0');
                
                return `${formattedHours}:${formattedMinutes} ${ampm}`;
            } catch (error) {
                console.error('Error formatting date:', error);
                return '';
            }
        };

        // update getCurrentKuwaitTime to return proper utc  time
        this.getCurrentKuwaitTime = () => {
            const now = new Date();
            // convert to utc string format that matches server format
            return now.toISOString().replace('T', ' ').split('.')[0];
        };

        // use reactive state
        this.state = useState({
            conversations: [],
            filteredConversations: [],
            displayedConversations: [],
            selectedConversation: null,
            messages: [],
            loading: false,
            error: null,
            searchQuery: '',
            userInfo: {
                name: this.user.name || 'User',
                avatarUrl: this._getUserAvatarUrl(this.user.userId)
            },
            // pagination state
            limit: 20,
            offset: 0,
            total: 0,
            currentPage: 1,
            messageOffset: 0,
            messageLimit: 50,
            messageTotal: 0,
            isRecording: false,
            recordingDuration: 0
        });

        this.messagePollingInterval = 5000; // 5 seconds
        this._pollTimeout = null;

        onWillStart(async () => {
            await this._loadConversations();
        });

        onMounted(() => {
            this._startPolling();
            // add event listener for search input
            const searchInput = document.querySelector('.o_whatsapp_search_input');
            if (searchInput) {
                searchInput.addEventListener('input', this._onSearch.bind(this));
            }
        });

        onWillUnmount(() => {
            this._stopPolling();
            //remove event listener
            const searchInput = document.querySelector('.o_whatsapp_search_input');
            if (searchInput) {
                searchInput.removeEventListener('input', this._onSearch.bind(this));
            }
        });

        // clear message input helper
        this.clearMessageInput = () => {
            if (this.messageInputRef.el) {
                this.messageInputRef.el.value = '';
            }
            if (this.fileInputRef.el) {
                this.fileInputRef.el.value = '';
            }
            this.state.selectedAttachments = [];
        };
    }

    // --------------------------------------------------------------------------
    // pagination method
    // --------------------------------------------------------------------------

    _updatePaging() {
        const conversations = this.state.searchQuery ? 
            this.state.filteredConversations : 
            this.state.conversations;

        const start = this.state.offset;
        const end = Math.min(start + this.state.limit, conversations.length);
        this.state.displayedConversations = conversations.slice(start, end);
    }

    async _onPagerChanged({ offset }) {
        if (this.state.loading) return;
        
        this.state.offset = offset;
        // clear current displayed conversations before loading new ones
        this.state.displayedConversations = [];
        await this._loadConversations();
    }

    // --------------------------------------------------------------------------
    // private
    // --------------------------------------------------------------------------

    _getUserAvatarUrl(userId) {
        return userId ? 
            `/web/image/res.users/${userId}/avatar_128?unique=${Date.now()}` : 
            '/whatsapp_custom_page/static/src/img/default_avatar.png';
    }

    _getPartnerAvatarUrl(partnerId) {
        return partnerId ? 
            `/web/image/res.partner/${partnerId}/avatar_128?unique=${Date.now()}` : 
            '/whatsapp_custom_page/static/src/img/default_avatar.png';
    }

    async _loadConversations() {
        try {
            this.state.loading = true;
            const result = await this.rpc("/whatsapp/conversations", {
                offset: this.state.offset,
                limit: this.state.limit,
                minimal: false,
                sort_by_last_message: true,
                include_mail_messages: true  // include messages from mail module
            });
            if (result.error) {
                this.state.error = result.error;
            } else {
                // update pagination state
                this.state.total = result.total_count || 0;
                this.state.offset = result.offset || 0;
                this.state.limit = result.limit || 20;

                // group and sort conversations by last message date
                const groupedConversations = this._groupConversationsByContact(result.conversations || []);
                
                // sort conversations by last_message_date in descending order
                const sortedConversations = groupedConversations.sort((a, b) => {
                    const dateA = new Date(a.last_message_date || 0);
                    const dateB = new Date(b.last_message_date || 0);
                    return dateB - dateA;
                });
                
                // update the conversations lists
                if (this.state.offset === 0) {
                    // First page - replace all conversations
                    this.state.conversations = sortedConversations;
                } else {
                    // get existing conversations excluding the ones about to add
                    const existingConvIds = new Set(sortedConversations.map(conv => conv.id));
                    const existingConversations = this.state.conversations.filter(
                        conv => !existingConvIds.has(conv.id)
                    );
                    
                    // merge and resort all conversations
                    this.state.conversations = [...existingConversations, ...sortedConversations]
                        .sort((a, b) => {
                            const dateA = new Date(a.last_message_date || 0);
                            const dateB = new Date(b.last_message_date || 0);
                            return dateB - dateA;
                        });
                }
                
                // update filtered and displayed conversations
                if (this.state.searchQuery) {
                    this._applySearchFilter(this.state.searchQuery);
                } else {
                    this.state.filteredConversations = this.state.conversations;
                    this._updatePaging();
                }
                this.state.error = null;

                // if there's a selected conversation reload its messages
                if (this.state.selectedConversation) {
                    const updatedConv = this.state.conversations.find(
                        conv => conv.id === this.state.selectedConversation.id
                    );
                    if (updatedConv) {
                        await this._loadMessages(updatedConv);
                    }
                }
            }
        } catch (error) {
            this.state.error = "Failed to load conversations";
            console.error("Error loading conversations:", error);
        } finally {
            this.state.loading = false;
        }
    }

    _groupConversationsByContact(conversations) {
        // create a map to group conversations
        const groupedMap = new Map();

        conversations.forEach(conv => {
            const key = `${conv.id}-${conv.partner_id || ''}-${conv.phone || ''}`;
            // check if message is sent by current user
            const isSentMessage = conv.last_message_author_id === this.user.partnerId;
            
            if (!groupedMap.has(key)) {
                // initialize new conversation with proper sent status and unread count
                groupedMap.set(key, {
                    ...conv,
                    messages: [conv],
                    last_message: this._formatMessageBody(conv.last_message),
                    total_unread: isSentMessage ? 0 : (conv.unread_count || 0),
                    last_message_date: conv.last_message_date || conv.create_date || new Date().toISOString(),
                    is_sent: isSentMessage,
                    unread_count: isSentMessage ? 0 : (conv.unread_count || 0)
                });
            } else {
                const existing = groupedMap.get(key);
                existing.messages.push(conv);
                
                // update last message if newer
                const existingDate = new Date(existing.last_message_date || 0);
                const currentDate = new Date(conv.last_message_date || conv.create_date || 0);
                
                if (currentDate > existingDate) {
                    existing.last_message = this._formatMessageBody(conv.last_message);
                    existing.last_message_date = conv.last_message_date || conv.create_date;
                    existing.last_message_author_id = conv.last_message_author_id;
                    existing.is_sent = isSentMessage;
                    
                    // only update unread counts if the message is not sent by the current user
                    if (isSentMessage) {
                        existing.total_unread = 0;
                        existing.unread_count = 0;
                    } else {
                        existing.total_unread = conv.unread_count || 0;
                        existing.unread_count = conv.unread_count || 0;
                    }
                }
            }
        });

        return Array.from(groupedMap.values());
    }

    async _loadMessages(conversation) {
        if (!conversation) return;

        try {
            this.state.loading = true;
            const result = await this.rpc("/whatsapp/messages", {
                channel_id: conversation.id,
                offset: this.state.messageOffset || 0,
                limit: this.state.messageLimit || 50,
                include_mail_messages: true
            });
            if (result.error) {
                this.state.error = result.error;
            } else {
                // check if the last message was sent by the current user
                const lastMessage = result.messages?.[result.messages.length - 1];
                const isSentMessage = lastMessage?.author_id === this.user.partnerId;

                // update conversation immediately to prevent badge flicker
                if (isSentMessage) {
                    const updatedConversations = this.state.conversations.map(conv => {
                        if (conv.id === conversation.id) {
                            return {
                                ...conv,
                                unread_count: 0,
                                total_unread: 0,
                                is_sent: true,
                                last_message_author_id: this.user.partnerId
                            };
                        }
                        return conv;
                    });
                    this.state.conversations = updatedConversations;
                    this._updatePaging();
                }

                // format message bodies and determine direction
                const formattedMessages = (result.messages || []).map(msg => ({
                    ...msg,
                    body: this._formatMessageBody(msg.body),
                    direction: msg.author_id === this.user.partnerId ? 'outbound' : 'inbound',
                    is_whatsapp: msg.is_whatsapp || false,
                    is_sent: msg.author_id === this.user.partnerId
                }));

                // sort messages by date
                formattedMessages.sort((a, b) => {
                    const dateA = new Date(a.create_date || 0);
                    const dateB = new Date(b.create_date || 0);
                    return dateA - dateB;
                });

                // update pagination info
                this.state.messageTotal = result.total_count;
                this.state.messageOffset = result.offset;
                this.state.messageLimit = result.limit;

                // append or prepend messages based on the current state
                if (this.state.messageOffset === 0) {
                    this.state.messages = formattedMessages;
                    setTimeout(() => this._scrollToBottom(), 100);
                } else {
                    const previousScrollHeight = this.messageContainerRef.el?.scrollHeight || 0;
                    this.state.messages = [...formattedMessages, ...this.state.messages];
                    setTimeout(() => {
                        if (this.messageContainerRef.el) {
                            const newScrollHeight = this.messageContainerRef.el.scrollHeight;
                            this.messageContainerRef.el.scrollTop = newScrollHeight - previousScrollHeight;
                        }
                    }, 100);
                }

                // update conversation with latest message if available
                if (formattedMessages.length > 0) {
                    const latestMessage = formattedMessages[formattedMessages.length - 1];
                    const isSentMessage = latestMessage.author_id === this.user.partnerId;
                    
                    const updatedConv = {
                        ...conversation,
                        last_message: this._formatMessageBody(latestMessage.body),
                        last_message_date: latestMessage.create_date,
                        last_message_author_id: latestMessage.author_id,
                        is_sent: isSentMessage,
                        unread_count: isSentMessage ? 0 : conversation.unread_count,
                        total_unread: isSentMessage ? 0 : conversation.total_unread
                    };

                    // update without changing page or resetting unread status
                    this._updateConversationOrder(updatedConv, true, false);
                }

                this.state.error = null;
            }
        } catch (error) {
            this.state.error = "Failed to load messages";
            console.error("Error loading messages:", error);
        } finally {
            this.state.loading = false;
        }
    }

    async _sendMessage(message, attachmentIds = []) {
        if (!this.state.selectedConversation) return;
        
        try {
            // format message body before sending
            if (message) {
                message = this.formatMessageBody(message);
            }

            // create the message object with sent properties before sending
            const newMessage = {
                body: message,
                create_date: this.getCurrentKuwaitTime(),
                direction: 'outbound',
                is_whatsapp: true,
                is_read: true,
                author_id: this.user.partnerId,
                unread_count: 0,
                total_unread: 0,
                is_sent: true,
                status: 'sent'
            };

            // update conversation immediately to prevent badge flicker
            const updatedConv = {
                ...this.state.selectedConversation,
                last_message: message,
                last_message_date: newMessage.create_date,
                last_message_author_id: this.user.partnerId,
                unread_count: 0,
                total_unread: 0,
                is_sent: true,
                messages: [...(this.state.selectedConversation.messages || []), newMessage]
            };

            // update all conversation lists immediately to prevent badge flicker
            const updatedConversations = this.state.conversations.map(conv => {
                if (conv.id === updatedConv.id) {
                    return {
                        ...conv,
                        last_message: message,
                        last_message_date: newMessage.create_date,
                        last_message_author_id: this.user.partnerId,
                        unread_count: 0,
                        total_unread: 0,
                        is_sent: true
                    };
                }
                return conv;
            });
            this.state.conversations = updatedConversations;
            this._updatePaging();

            // update the selected conversation
            this.state.selectedConversation = updatedConv;

            // add message to messages list immediately
            this.state.messages = [...this.state.messages, newMessage];

            const result = await this.rpc('/whatsapp/send', {
                channel_id: this.state.selectedConversation.id,
                message: message,
                attachment_ids: attachmentIds,
                mark_as_read: true
            });

            if (result.error) {
                throw new Error(result.error);
            }

            // clear input after successful send
            this.clearMessageInput();

            // update with server response while maintaining sent status
            if (result.message) {
                const serverMessage = {
                    ...result.message,
                    body: this.formatMessageBody(result.message.body),
                    direction: 'outbound',
                    is_whatsapp: true,
                    is_read: true,
                    author_id: this.user.partnerId,
                    unread_count: 0,
                    total_unread: 0,
                    is_sent: true
                };
                
                // replace the temporary message with the server message
                this.state.messages = this.state.messages.map(msg => 
                    msg.create_date === newMessage.create_date ? serverMessage : msg
                );
                
                this._scrollToBottom(true);
            }

            return result;
        } catch (error) {
            console.error('Error sending message:', error);
            this.state.error = error.message || 'Failed to send message';
            return false;
        }
    }

    _updateConversationOrder(updatedConv, maintainReadStatus = false, moveToFirstPage = true) {
        // find the conversation in the current list
        const conversations = [...this.state.conversations];
        const index = conversations.findIndex(conv => 
            conv.id === updatedConv.id || 
            (conv.partner_id === updatedConv.partner_id && conv.phone === updatedConv.phone)
        );

        // always ensure sent messages have no unread count
        if (updatedConv.last_message_author_id === this.user.partnerId || updatedConv.is_sent) {
            updatedConv = {
                ...updatedConv,
                unread_count: 0,
                total_unread: 0,
                is_sent: true
            };
        }

        if (moveToFirstPage) {
            // for new messages remove from current position and add to beginning
            if (index !== -1) {
                conversations.splice(index, 1);
            }
            conversations.unshift(updatedConv);

            // reset to first page
            this.state.offset = 0;
            this.state.currentPage = 1;
        } else {
            // for just viewing update in place without changing position
            if (index !== -1) {
                conversations[index] = updatedConv;
            }
        }

        // update state
        this.state.conversations = conversations;
        this._updatePaging();

        // if this is the selected conversation update its messages
        if (this.state.selectedConversation && 
            (this.state.selectedConversation.id === updatedConv.id || 
             (this.state.selectedConversation.partner_id === updatedConv.partner_id && 
              this.state.selectedConversation.phone === updatedConv.phone))) {
            this.state.selectedConversation = updatedConv;
        }
    }

    _startPolling() {
        // clear any existing polling
        this._stopPolling();
        
        // prevent start polling if it already disabled
        if (!this.messagePollingInterval) return;
        
        this._pollTimeout = setTimeout(async () => {
            try {
                await this._loadConversations();  // use _loadConversations instead of _poll
            } catch (error) {
                console.error("Polling error:", error);
            } finally {
                // schedule next poll
                this._pollTimeout = setTimeout(() => this._startPolling(), this.messagePollingInterval);
            }
        }, this.messagePollingInterval);
    }

    _stopPolling() {
        if (this._pollTimeout) {
            clearTimeout(this._pollTimeout);
            this._pollTimeout = null;
        }
    }

    _applySearchFilter(query) {
        if (!query) {
            this.state.filteredConversations = this.state.conversations;
        } else {
            const lowercaseQuery = query.toLowerCase();
            this.state.filteredConversations = this.state.conversations.filter(conv => {
                const name = (conv.partner_name || '').toLowerCase();
                const phone = (conv.phone || '').toLowerCase();
                const lastMessage = (conv.last_message || '').toLowerCase();
                
                return name.includes(lowercaseQuery) || 
                       phone.includes(lowercaseQuery) || 
                       lastMessage.includes(lowercaseQuery);
            });
        }
        
        //reset pagination when search changes
        this.state.offset = 0;
        this.state.currentPage = 1;
        this._updatePaging();
    }

    _formatMessageBody(body) {
        if (!body) return '';
        // remove <p> tags and other HTML tags
        return body.replace(/<p>(.*?)<\/p>/g, '$1')  //replace <p>text</p> with just text
                  .replace(/<br\s*\/?>/gi, '\n')     // replace <br> with newline
                  .replace(/<[^>]*>/g, '')           // remove any other HTML tags
                  .replace(/&lt;/g, '<')
                  .replace(/&gt;/g, '>')
                  .replace(/&nbsp;/g, ' ')
                  .trim();
    }

    _scrollToBottom(smooth = false) {
        if (this.messageContainerRef.el) {
            const container = this.messageContainerRef.el;
            const scrollOptions = smooth ? { behavior: 'smooth' } : undefined;
            
            // use requestAnimationFrame to ensure DOM is updated
            requestAnimationFrame(() => {
                container.scrollTo({
                    top: container.scrollHeight,
                    ...scrollOptions
                });
            });
        }
    }

    async _onLoadMoreMessages() {
        if (this.state.loading || !this.state.selectedConversation) return;
        
        const newOffset = (this.state.messageOffset || 0) + (this.state.messageLimit || 50);
        if (newOffset >= this.state.messageTotal) return;
        
        this.state.messageOffset = newOffset;
        await this._loadMessages(this.state.selectedConversation);
    }

    _onScroll(ev) {
        const container = ev.target;
        // load more messages when scrolling near the top
        if (container.scrollTop <= 100 && !this.state.loading) {
            this._onLoadMoreMessages();
        }
    }

    // --------------------------------------------------------------------------
    // handlers
    // --------------------------------------------------------------------------

    async _onClickConversation(conversation) {
        if (!conversation || !conversation.id) return;

        // update selected conversation first
        this.state.selectedConversation = { ...conversation };
        this.state.messages = []; // clear existing messages
        
        // load messages
        await this._loadMessages(conversation);

        // mark messages as read
        try {
            await this.rpc("/whatsapp/mark_as_read", {
                channel_id: conversation.id
            });

            // update the unread count in the conversation list while maintaining exact position
            const updatedConversations = [...this.state.conversations];
            const convIndex = updatedConversations.findIndex(conv => conv.id === conversation.id);
            
            if (convIndex !== -1) {
                updatedConversations[convIndex] = {
                    ...updatedConversations[convIndex],
                    unread_count: 0,
                    total_unread: 0
                };
            }

            // update state while maintaining exact positions
            this.state.conversations = updatedConversations;
            
            // update filtered conversations if search is active
            if (this.state.searchQuery) {
                const filteredConvs = [...this.state.filteredConversations];
                const filteredIndex = filteredConvs.findIndex(conv => conv.id === conversation.id);
                
                if (filteredIndex !== -1) {
                    filteredConvs[filteredIndex] = {
                        ...filteredConvs[filteredIndex],
                        unread_count: 0,
                        total_unread: 0
                    };
                    this.state.filteredConversations = filteredConvs;
                }
            }

            // update displayed conversations while maintaining exact positions
            const start = this.state.offset;
            const end = Math.min(start + this.state.limit, updatedConversations.length);
            this.state.displayedConversations = updatedConversations.slice(start, end);

        } catch (error) {
            console.error("Error marking messages as read:", error);
        }
    }

    async _onClickSend() {
        const messageInput = this.messageInputRef.el;
        const message = messageInput?.value?.trim() || '';
        
        if (!message && !this.state.selectedAttachments?.length) {
            return;
        }

        const attachmentIds = this.state.selectedAttachments?.map(att => att.id) || [];
        const result = await this._sendMessage(message, attachmentIds);
        
        if (result) {
            this.clearMessageInput();
        }
    }

    _onKeydown(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            this._onClickSend();
        }
    }

    async _onAttachmentChange(ev) {
        const files = Array.from(ev.target.files);
        if (!files.length) return;

        try {
            const formData = new FormData();
            files.forEach(file => {
                formData.append('files[]', file);
            });
            formData.append('channel_id', this.state.selectedConversation.id);
            formData.append('csrf_token', odoo.csrf_token);
            formData.append('file_type', files[0].type);

            const response = await fetch('/whatsapp/upload_attachment', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin',
            });

            const result = await response.json();

            if (result.error) {
                this.state.error = result.error;
            } else if (result.message) {
                // add the new message to the UI
                const newMessage = {
                    ...result.message,
                    body: this._formatMessageBody(result.message.body),
                    direction: 'outbound',
                };

                // append new message at the end
                this.state.messages = [...this.state.messages, newMessage];

                // update the conversation in the list immediately
                const attachmentType = this._getAttachmentPreviewText(files[0].type);
                const updatedConv = {
                    ...this.state.selectedConversation,
                    last_message: attachmentType,
                    last_message_date: result.message.create_date,
                    unread_count: 0,
                    total_unread: 0
                };

                // update conversations list while maintaining read status
                this._updateConversationOrder(updatedConv, true);

                // notify discuss about the new message
                this.env.bus.trigger('discuss.message_created', {
                    channelId: this.state.selectedConversation.id,
                    messageId: result.message.id,
                });

                this._scrollToBottom();
            }
        } catch (error) {
            this.state.error = "Failed to upload attachments";
            console.error("Error uploading attachments:", error);
        }

        // clear the input
        ev.target.value = '';
    }

    _getAttachmentPreviewText(mimeType) {
        if (mimeType.startsWith('image/')) {
            return '📷 Photo';
        } else if (mimeType.startsWith('video/')) {
            return '🎥 Video';
        } else if (mimeType.startsWith('audio/')) {
            return '🎤 Voice message';
        } else {
            return '📎 File';
        }
    }

    async startVoiceRecording() {
        try {
            if (!this.state.selectedConversation) {
                throw new Error(_t('Please select a conversation first'));
            }

            // request microphone permission first
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    sampleRate: 44100,
                    channelCount: 1
                }
            });

            // check if MediaRecorder is supported
            if (!window.MediaRecorder) {
                throw new Error(_t('MediaRecorder is not supported in this browser'));
            }

            // set up MediaRecorder with optimal settings for voice
            const options = {
                mimeType: this._getSupportedMimeType(),
                audioBitsPerSecond: 128000
            };

            this.mediaRecorder = new MediaRecorder(stream, options);
            this.audioChunks = [];

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = async () => {
                try {
                    if (this.audioChunks.length === 0) {
                        console.warn('No audio data recorded');
                        return;
                    }

                    const audioBlob = new Blob(this.audioChunks, { type: this._getSupportedMimeType() });
                    if (audioBlob.size === 0) {
                        console.warn('Empty audio blob created');
                        return;
                    }

                    const formData = new FormData();
                    formData.append('audio', audioBlob, 'voice_message.webm');
                    formData.append('channel_id', this.state.selectedConversation.id);
                    formData.append('csrf_token', odoo.csrf_token);

                    const response = await fetch('/whatsapp/upload_voice', {
                        method: 'POST',
                        body: formData,
                        credentials: 'same-origin',
                    });

                    if (!response.ok) {
                        throw new Error(_t('Failed to upload voice message. Server returned: ') + response.status);
                    }

                    const result = await response.json();

                    if (result.error) {
                        throw new Error(result.error);
                    }

                    if (result.message) {
                        const newMessage = {
                            ...result.message,
                            body: this._formatMessageBody(result.message.body),
                            direction: 'outbound',
                        };

                        this.state.messages = [...this.state.messages, newMessage];

                        const updatedConv = {
                            ...this.state.selectedConversation,
                            last_message: '🎤 Voice message',
                            last_message_date: result.message.create_date,
                            unread_count: 0,
                            total_unread: 0
                        };

                        this._updateConversationOrder(updatedConv, true);
                        this._scrollToBottom();
                    }
                } catch (error) {
                    console.error("Error uploading voice message:", error);
                    this.dialogService.add(Dialog, {
                        title: _t("Error"),
                        body: error.message || _t("Failed to upload voice message. Please try again."),
                    });
                } finally {
                    this._cleanupRecording();
                }
            };

            // start recording
            this.mediaRecorder.start(1000);
            this.state.isRecording = true;
            this._startRecordingTimer();

            // set up audio visualization if supported
            this._setupAudioVisualization(stream);

        } catch (error) {
            console.error("Error starting voice recording:", error);
            this.dialogService.add(Dialog, {
                title: _t("Recording Error"),
                body: error.message || _t("Could not access microphone. Please check your browser permissions and try again."),
            });
            this._cleanupRecording();
        }
    }

    _getSupportedMimeType() {
        const types = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus',
            'audio/ogg',
            'audio/mp4',
            'audio/mpeg',
        ];
        
        for (const type of types) {
            if (MediaRecorder.isTypeSupported(type)) {
                return type;
            }
        }
        
        return 'audio/webm;codecs=opus'; // default fallback
    }

    _setupAudioVisualization(stream) {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            const source = this.audioContext.createMediaStreamSource(stream);
            const analyser = this.audioContext.createAnalyser();
            
            analyser.fftSize = 256;
            source.connect(analyser);
            
            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);
            
            const updateVisualizer = () => {
                if (!this.state.isRecording) {
                    if (this.audioContext) {
                        source.disconnect();
                    }
                    return;
                }
                
                analyser.getByteFrequencyData(dataArray);
                
                // update visualization bars
                const bars = this.voiceRecorderRef.el?.querySelectorAll('.o_whatsapp_voice_bar');
                if (bars) {
                    const step = Math.floor(bufferLength / bars.length);
                    bars.forEach((bar, index) => {
                        const value = dataArray[index * step];
                        const height = (value / 255) * 100;
                        bar.style.height = `${Math.max(20, height)}%`;
                        bar.style.opacity = Math.max(0.3, height / 100);
                    });
                }
                
                requestAnimationFrame(updateVisualizer);
            };
            
            updateVisualizer();
            
        } catch (error) {
            console.warn('Audio visualization not supported:', error);
        }
    }

    _cleanupRecording() {
        try {
            if (this.mediaRecorder && this.mediaRecorder.stream) {
                this.mediaRecorder.stream.getTracks().forEach(track => track.stop());
            }
            if (this.audioContext) {
                this.audioContext.close().catch(console.error);
                this.audioContext = null;
            }
            this.mediaRecorder = null;
            this.audioChunks = [];
            this.state.isRecording = false;
            this._stopRecordingTimer();
        } catch (error) {
            console.error('Error cleaning up recording:', error);
        }
    }

    stopVoiceRecording() {
        if (this.mediaRecorder && this.state.isRecording) {
            try {
                this.mediaRecorder.stop();
            } catch (error) {
                console.error("Error stopping voice recording:", error);
                this._cleanupRecording();
            }
        }
    }

    cancelVoiceRecording() {
        if (this.mediaRecorder && this.state.isRecording) {
            try {
                this.mediaRecorder.stop();
                this.audioChunks = []; // clear the recorded data
            } catch (error) {
                console.error("Error canceling voice recording:", error);
            } finally {
                this._cleanupRecording();
            }
        }
    }

    _startRecordingTimer() {
        this.state.recordingDuration = 0;
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
        }
        this.recordingTimer = setInterval(() => {
            if (this.state.isRecording) {
                this.state.recordingDuration++;
            } else {
                this._stopRecordingTimer();
            }
        }, 1000);
    }

    _stopRecordingTimer() {
        if (this.recordingTimer) {
            clearInterval(this.recordingTimer);
            this.recordingTimer = null;
        }
    }

    formatRecordingDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    _onSearch(event) {
        const query = event.target.value;
        this.state.searchQuery = query;
        this._applySearchFilter(query);
    }

    async onImageClick(attachment) {
        if (!attachment || !attachment.id) {
            console.error('Invalid attachment:', attachment);
            return;
        }

        class ImagePreviewDialog extends Dialog {
            setup() {
                super.setup();
                this.attachment = this.props.attachment;
            }
            static template = "whatsapp_custom_page.ImagePreviewDialog";
            static components = { Dialog };
            static props = {
                ...Dialog.props,
                attachment: { type: Object },
            };
        }

        // open the dialog with the image preview
        this.dialogService.add(ImagePreviewDialog, {
            attachment: {
                ...attachment,
                url: `/web/image/${attachment.id}?unique=${Date.now()}`
            },
            size: 'xl',
            technical: false,
            fullscreen: true,
        });
    }

    async onVideoClick(attachment) {
        if (!attachment || !attachment.id) {
            console.error('Invalid attachment:', attachment);
            return;
        }

        class VideoPreviewDialog extends Dialog {
            setup() {
                super.setup();
                this.attachment = this.props.attachment;
            }
            static template = "whatsapp_custom_page.VideoPreviewDialog";
            static components = { Dialog };
            static props = {
                ...Dialog.props,
                attachment: { type: Object },
            };
        }

        this.dialogService.add(VideoPreviewDialog, {
            attachment: {
                ...attachment,
                url: `/web/content/${attachment.id}/datas`
            },
            size: 'fullscreen',
            technical: false,
            title: " ",
        });
    }

    toggleAudio(ev, attachment) {
        if (!ev || !attachment) return;
        
        const button = ev.currentTarget;
        if (!button) return;

        const playerDiv = button.closest('.o_whatsapp_voice_player');
        if (!playerDiv) return;

        const audio = playerDiv.querySelector('audio');
        const progress = playerDiv.querySelector('.o_whatsapp_voice_progress');
        const duration = playerDiv.querySelector('.o_whatsapp_voice_duration');
        const waveform = playerDiv.querySelector('.o_whatsapp_voice_wave');
        
        if (!audio || !progress || !duration || !waveform) return;

        const updateDuration = (timeInSeconds) => {
            const minutes = Math.floor(timeInSeconds / 60);
            const seconds = Math.floor(timeInSeconds % 60);
            duration.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        };

        const updateProgress = () => {
            const percent = (audio.currentTime / audio.duration) * 100;
            progress.style.width = `${percent}%`;
            updateDuration(audio.duration - audio.currentTime);
        };

        // stop all other playing audio elements first
        document.querySelectorAll('.o_whatsapp_voice_player audio').forEach(otherAudio => {
            if (otherAudio !== audio && !otherAudio.paused) {
                otherAudio.pause();
                const otherButton = otherAudio.closest('.o_whatsapp_voice_player').querySelector('.o_whatsapp_voice_play_button');
                if (otherButton) {
                    otherButton.classList.remove('playing');
                }
            }
        });

        if (audio.paused) {
            // load metadata if not loaded
            if (!audio.duration) {
                audio.addEventListener('loadedmetadata', () => {
                    updateDuration(audio.duration);
                }, { once: true });
            }

            // play audio
            audio.play().then(() => {
                button.classList.add('playing');
                audio.addEventListener('timeupdate', updateProgress);
                audio.addEventListener('ended', () => {
                    button.classList.remove('playing');
                    progress.style.width = '0%';
                    updateDuration(audio.duration);
                    audio.removeEventListener('timeupdate', updateProgress);
                }, { once: true });
            }).catch(error => {
                console.error('Error playing audio:', error);
            });
        } else {
            audio.pause();
            button.classList.remove('playing');
            audio.removeEventListener('timeupdate', updateProgress);
        }
    }

    // --------------------------------------------------------------------------
    // static
    // --------------------------------------------------------------------------

    static template = "whatsapp_custom_page.ChatWindow";
    static components = { Pager, Dialog };
    static props = {
        action: { type: Object, optional: true },
        actionId: { type: [Number, String], optional: true },
        className: { type: String, optional: true }
    };
}

registry.category("actions").add("whatsapp_chat", WhatsAppChat);

export default WhatsAppChat; 