/** @odoo-module **/

import { patch } from "@web/core/utils/patch";
import { WhatsAppChat } from "./whatsapp_chat";

patch(WhatsAppChat.prototype, {
    setup() {
        this._super(...arguments);
        this.formatMessageBody = this.formatMessageBody.bind(this);
    },

    formatMessageBody(body) {
        if (!body) return '';
        
        // remove html tag
        let cleanBody = body.replace(/<[^>]*>/g, '');
        
        // replace html entities
        cleanBody = cleanBody.replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&');
        
        return cleanBody.trim();
    },

    _sendMessage(message) {
        // format the message before sending
        if (message.body) {
            message.body = this.formatMessageBody(message.body);
        }
        return this._super(...arguments);
    },

    _onMessageReceived(message) {
        // format received message
        if (message.body) {
            message.body = this.formatMessageBody(message.body);
        }
        return this._super(...arguments);
    }
}); 