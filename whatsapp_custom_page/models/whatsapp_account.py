from odoo import models, fields, api, _
import requests
import json
import logging
import base64

_logger = logging.getLogger(__name__)

class WhatsAppAccount(models.Model):
    _name = 'whatsapp.account'
    _description = 'WhatsApp Account'

    name = fields.Char('Name', required=True)
    webhook_url = fields.Char('Webhook URL', required=True)
    access_token = fields.Char('Access Token', required=True)
    active = fields.Boolean('Active', default=True)

    def _send_whatsapp_message(self, message_data):
        """Send message through WhatsApp API"""
        self.ensure_one()
        try:
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Content-Type': 'application/json'
            }

            # prepare the payload
            payload = {
                'messaging_product': 'whatsapp',
                'recipient_type': 'individual',
                'to': message_data.get('phone'),
                'type': 'text',
            }

            #handle different types of messages
            if message_data.get('image'):
                payload['type'] = 'image'
                payload['image'] = {
                    'link': self._upload_media(message_data['image'], 'image')
                }
            elif message_data.get('audio'):
                payload['type'] = 'audio'
                payload['audio'] = {
                    'link': self._upload_media(message_data['audio'], 'audio')
                }
            elif message_data.get('video'):
                payload['type'] = 'video'
                payload['video'] = {
                    'link': self._upload_media(message_data['video'], 'video')
                }
            elif message_data.get('document'):
                payload['type'] = 'document'
                payload['document'] = {
                    'link': self._upload_media(message_data['document'], 'document'),
                    'filename': message_data.get('filename', 'document')
                }
            else:
                payload['text'] = {'body': message_data.get('body', '')}

            # send the message
            response = requests.post(
                f"{self.webhook_url}/messages",
                headers=headers,
                json=payload,
                timeout=10
            )

            if response.status_code == 200:
                result = response.json()
                return {
                    'success': True,
                    'message_id': result.get('messages', [{}])[0].get('id')
                }
            else:
                _logger.error("WhatsApp API error: %s", response.text)
                return {'success': False, 'error': response.text}

        except Exception as e:
            _logger.error("Error sending WhatsApp message: %s", str(e))
            return {'success': False, 'error': str(e)}

    def _upload_media(self, media_data, media_type):
        """Upload media to WhatsApp servers"""
        try:
            headers = {
                'Authorization': f'Bearer {self.access_token}',
                'Content-Type': 'application/json'
            }

            # convert base64 to binary
            binary_data = base64.b64decode(media_data)

            # upload media
            files = {
                'file': (f'file.{media_type}', binary_data, f'{media_type}/octet-stream')
            }
            
            response = requests.post(
                f"{self.webhook_url}/media",
                headers={'Authorization': headers['Authorization']},
                files=files,
                timeout=30
            )

            if response.status_code == 200:
                result = response.json()
                return result.get('media', {}).get('link')
            else:
                _logger.error("Media upload error: %s", response.text)
                return None

        except Exception as e:
            _logger.error("Error uploading media: %s", str(e))
            return None 