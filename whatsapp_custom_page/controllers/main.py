from odoo import http, _
from odoo.http import request
from odoo.exceptions import AccessError, UserError
from odoo.tools import html2plaintext
from odoo.osv import expression
from werkzeug.exceptions import NotFound
import json
import re
from datetime import datetime, timedelta
import logging
import base64

_logger = logging.getLogger(__name__)


class WhatsAppController(http.Controller):
    @http.route('/whatsapp/chat', type='http', auth='user')
    def whatsapp_chat_page(self, **kwargs):
        try:
            # check if whatsapp module is properly installed and configured
            WhatsAppAccount = request.env['whatsapp.account'].sudo()
            account = WhatsAppAccount.search([], limit=1)
            
            if not account:
                return request.render('whatsapp_custom_page.chat_page', {
                    'error': _('No WhatsApp account configured. Please configure one in WhatsApp Settings.')
                })
            
            #check if account is properly configured
            if not account.webhook_url or not account.access_token:
                return request.render('whatsapp_custom_page.chat_page', {
                    'error': _('WhatsApp account is not fully configured. Please set up webhook URL and access token.')
                })
            
            values = {
                'account': account,
                'user': request.env.user,
            }
            return request.render('whatsapp_custom_page.chat_page', values)
        except Exception as e:
            return request.render('whatsapp_custom_page.chat_page', {
                'error': str(e)
            })

    @http.route('/whatsapp/conversations', type='json', auth='user')
    def get_conversations(self, offset=0, limit=20, search_term=None, **kwargs):
        try:
            DiscussChannel = request.env['discuss.channel'].sudo()
            
            # base domain
            domain = [
                ('channel_type', '=', 'whatsapp'),
                '|',
                ('channel_member_ids.partner_id', '=', request.env.user.partner_id.id),
                ('create_uid', '=', request.env.uid),
            ]
            
            # add search conditions if search term is provided
            if search_term:
                search_term = search_term.strip()
                # search in channel name (phone number) and partner name
                domain = expression.AND([
                    domain,
                    ['|', '|',
                        ('name', 'ilike', search_term),  # search in phone number
                        ('whatsapp_partner_id.name', 'ilike', search_term),  # search in partner name
                        ('message_ids.body', 'ilike', search_term),  # search in message content
                    ]
                ])
            
            # get total count for pagination
            total_count = DiscussChannel.search_count(domain)
            
            # get channels with pagination
            channels = DiscussChannel.search(
                domain,
                offset=offset,
                limit=limit,
                order='write_date desc, id desc'
            )
            
            # optimize by fetching all related data in bulk
            channel_ids = channels.ids
            message_domain = [
                ('model', '=', 'discuss.channel'),
                ('res_id', 'in', channel_ids),
                '|',
                ('message_type', 'in', ['whatsapp_message', 'whatsapp']),
                ('is_whatsapp', '=', True),
            ]
            
            # if searching in messages add message content to domain
            if search_term:
                message_domain = expression.OR([
                    message_domain,
                    [('body', 'ilike', search_term)]
                ])
            
            messages = request.env['mail.message'].sudo().search_read(
                message_domain,
                ['res_id', 'body', 'create_date', 'message_type', 'author_id', 'whatsapp_status', 'id', 'official_whatsapp_message_id'],
                order='create_date desc'
            )
            
            # create message lookup dict for O(1) access
            latest_messages = {}
            for msg in messages:
                if msg['res_id'] not in latest_messages:
                    latest_messages[msg['res_id']] = msg
            
            # get all channel members in one query
            channel_members = request.env['discuss.channel.member'].sudo().search_read(
                [
                    ('channel_id', 'in', channel_ids),
                    ('partner_id', '=', request.env.user.partner_id.id)
                ],
                ['channel_id', 'seen_message_id', 'message_unread_counter']
            )
            member_dict = {m['channel_id'][0]: m for m in channel_members}
            
            conversations = []
            WhatsAppMessage = request.env['whatsapp.message'].sudo()
            
            for channel in channels:
                # get the latest message for the channel
                latest_message = latest_messages.get(channel.id)
                if not latest_message and not search_term:  # Skip if no message unless searching
                    continue
                
                # get channel member for unread count
                channel_member = member_dict.get(channel.id)
                unread_count = channel_member.get('message_unread_counter', 0) if channel_member else 0
                
                # clean message body from html tags
                message_body = latest_message.get('body', '') if latest_message else ''
                if message_body:
                    try:
                        message_body = html2plaintext(message_body)
                    except Exception:
                        message_body = re.sub(r'<[^>]*>', '', message_body).strip()
                
                # determine message direction and status
                is_outbound = latest_message and latest_message.get('author_id') and latest_message['author_id'][0] == request.env.user.partner_id.id
                
                # get status from official message if it exists
                status = latest_message.get('whatsapp_status', 'sent') if latest_message else None
                if latest_message and latest_message.get('official_whatsapp_message_id'):
                    official_msg = WhatsAppMessage.browse(latest_message['official_whatsapp_message_id'][0])
                    if official_msg.exists():
                        status_mapping = {
                            'sent': 'sent',
                            'delivered': 'delivered',
                            'read': 'read',
                            'error': 'failed'
                        }
                        status = status_mapping.get(official_msg.state, status)
                
                # format phone number for display
                phone = channel.name
                if ' - ' in phone:
                    phone = phone.split(' - ')[0]
                
                conversations.append({
                    'id': channel.id,
                    'phone': phone,
                    'partner_name': channel.whatsapp_partner_id.name if channel.whatsapp_partner_id else phone,
                    'partner_id': channel.whatsapp_partner_id.id if channel.whatsapp_partner_id else False,
                    'last_message': message_body,
                    'last_message_date': latest_message['create_date'] if latest_message else channel.create_date,
                    'unread_count': unread_count,
                    'status': status,
                    'direction': 'outbound' if is_outbound else 'inbound',
                    'is_sent': is_outbound,
                    'last_message_author_id': latest_message.get('author_id') and latest_message['author_id'][0] if latest_message else None,
                })
            
            return {
                'conversations': conversations,
                'total_count': total_count,
                'offset': offset,
                'limit': limit,
                'search_term': search_term,
            }
        except Exception as e:
            _logger.error("Error fetching WhatsApp conversations: %s", str(e))
            return {'error': str(e)}

    @http.route('/whatsapp/messages', type='json', auth='user')
    def get_messages(self, channel_id, offset=0, limit=50, **kwargs):
        try:
            if not channel_id:
                return {'error': _('Channel ID is required')}
            
            DiscussChannel = request.env['discuss.channel'].sudo()
            channel = DiscussChannel.browse(int(channel_id))
            
            if not channel.exists() or channel.channel_type != 'whatsapp':
                return {'error': _('WhatsApp channel not found')}
            
            # get total count for pagination
            domain = [
                ('model', '=', 'discuss.channel'),
                ('res_id', '=', channel.id),
                '|',
                ('message_type', 'in', ['whatsapp_message', 'whatsapp']),
                ('is_whatsapp', '=', True),
            ]
            
            total_count = request.env['mail.message'].sudo().search_count(domain)
            
            # get messages with pagination order by id desc to show newest first
            messages = request.env['mail.message'].sudo().search(
                domain,
                offset=offset,
                limit=limit,
                order='id desc'
            )
            
            # fetch related records
            messages.mapped('author_id')
            messages.mapped('attachment_ids')
            messages.mapped('official_whatsapp_message_id')
            
            # get channel member for the current user
            channel_member = channel.channel_member_ids.filtered(
                lambda m: m.partner_id == request.env.user.partner_id
            )
            
            result = []
            WhatsAppMessage = request.env['whatsapp.message'].sudo()
            
            for message in messages:
                is_outbound = message.author_id == request.env.user.partner_id
                
                # get status from official message if it exists
                status = message.whatsapp_status
                if message.official_whatsapp_message_id:
                    official_msg = message.official_whatsapp_message_id
                    if official_msg.exists():
                        status_mapping = {
                            'sent': 'sent',
                            'delivered': 'delivered',
                            'read': 'read',
                            'error': 'failed'
                        }
                        status = status_mapping.get(official_msg.state, 'failed')
                
                attachments = [{
                    'id': attachment.id,
                    'name': attachment.name,
                    'filename': attachment.name,
                    'url': f'/web/content/{attachment.id}?download=true',
                    'mimetype': attachment.mimetype,
                } for attachment in message.attachment_ids]
                
                result.append({
                    'id': message.id,
                    'body': message.body or '',
                    'author_name': message.author_id.name if message.author_id else _('Unknown'),
                    'author_id': message.author_id.id if message.author_id else False,
                    'direction': 'outbound' if is_outbound else 'inbound',
                    'create_date': message.create_date,
                    'date': message.date,
                    'status': status,
                    'attachment_ids': attachments,
                    'is_sent': is_outbound,
                    'whatsapp_message_id': message.whatsapp_message_id,
                    'official_whatsapp_message_id': message.official_whatsapp_message_id.id if message.official_whatsapp_message_id else False,
                    'error_message': message.error_message if hasattr(message, 'error_message') else None,
                })
            
            # mark messages as read only if loading the first page
            if offset == 0 and messages and channel_member:
                channel_member.write({
                    'seen_message_id': messages[0].id,
                    'fetched_message_id': messages[0].id,
                    'message_unread_counter': 0,  # reset unread counter
                })
            
            return {
                'messages': result,
                'total_count': total_count,
                'offset': offset,
                'limit': limit,
            }
        except Exception as e:
            _logger.error("Error fetching WhatsApp messages: %s", str(e))
            return {'error': str(e)}

    @http.route('/whatsapp/send', type='json', auth='user')
    def send_message(self, channel_id, message, attachment_ids=None):
        try:
            if not channel_id or not message:
                return {'error': _('Channel ID and message are required')}
            
            DiscussChannel = request.env['discuss.channel'].sudo()
            channel = DiscussChannel.browse(int(channel_id))
            
            if not channel.exists() or channel.channel_type != 'whatsapp':
                return {'error': _('WhatsApp channel not found')}

            # create mail message first
            message_vals = {
                'body': message,
                'message_type': 'comment',  
                'model': 'discuss.channel',
                'res_id': channel.id,
                'author_id': request.env.user.partner_id.id,
                'subtype_id': request.env.ref('mail.mt_comment').id,
                'is_whatsapp': True,
            }
            
            if attachment_ids:
                message_vals['attachment_ids'] = [(6, 0, attachment_ids)]
            
            new_message = request.env['mail.message'].sudo().create(message_vals)
            
            # extract phone number from channel name
            phone = channel.name.split(' - ')[0] if ' - ' in channel.name else channel.name
            phone = ''.join(filter(str.isdigit, phone))
            if phone:
                new_message.write({'whatsapp_phone': phone})
                
                # get wa account
                wa_account = request.env['whatsapp.account'].sudo().search([('active', '=', True)], limit=1)
                if wa_account:
                    # create message in official wa module
                    WhatsAppMessage = request.env['whatsapp.message'].sudo()
                    base_vals = {
                        'mobile_number': phone,
                        'mobile_number_formatted': phone,
                        'message_type': 'outbound',
                        'state': 'outgoing',
                        'wa_account_id': wa_account.id,
                        'mail_message_id': new_message.id,
                        'free_text_json': json.dumps({'body': message}),
                    }

                    if attachment_ids:
                        base_vals['attachment_ids'] = [(6, 0, attachment_ids)]

                    official_message = WhatsAppMessage.create(base_vals)
                    if official_message:
                        new_message.write({
                            'official_whatsapp_message_id': official_message.id,
                            'whatsapp_status': 'sent'
                        })
                        
                        # trigger the send method from the official module
                        try:
                            official_message._send_message(with_commit=True)
                        except Exception as e:
                            _logger.error("Error sending message through official module: %s", str(e))
                            # try using cron job as fallback
                            cron_job = request.env.ref('whatsapp.ir_cron_send_whatsapp_queue')
                            if cron_job:
                                cron_job.sudo()._trigger()
            
            # notify channel
            channel._notify_thread(new_message)
            
            return {
                'success': True,
                'message': {
                    'id': new_message.id,
                    'body': new_message.body,
                    'author_name': request.env.user.name,
                    'author_id': request.env.user.partner_id.id,
                    'direction': 'outbound',
                    'create_date': new_message.create_date,
                    'status': 'sent',
                    'attachment_ids': [{
                        'id': att.id,
                        'name': att.name,
                        'url': f'/web/content/{att.id}?download=true',
                        'mimetype': att.mimetype,
                    } for att in new_message.attachment_ids] if new_message.attachment_ids else [],
                }
            }
        except Exception as e:
            _logger.error("Error sending WhatsApp message: %s", str(e))
            return {'error': str(e)}

    @http.route('/whatsapp/mark_as_read', type='json', auth='user')
    def mark_messages_as_read(self, channel_id, **kwargs):
        try:
            channel = request.env['mail.channel'].sudo().browse(int(channel_id))
            if channel.exists():
                # mark all messages in the channel as read for the current user
                channel.message_ids.set_message_done()
                return {'success': True}
            return {'error': 'Channel not found'}
        except Exception as e:
            return {'error': str(e)}

    @http.route('/whatsapp/upload_attachment', type='http', auth='user', methods=['POST'], csrf=False)
    def upload_attachment(self, channel_id, **post):
        try:
            files = request.httprequest.files.getlist('files[]')
            if not files:
                return json.dumps({'error': 'No files uploaded'})

            if not channel_id:
                return json.dumps({'error': 'Channel ID is required'})

            channel = request.env['discuss.channel'].sudo().browse(int(channel_id))
            if not channel.exists() or channel.channel_type != 'whatsapp':
                return json.dumps({'error': 'WhatsApp channel not found'})

            attachment_ids = []
            for file in files:
                data = file.read()
                filename = file.filename
                mimetype = file.content_type

                attachment = request.env['ir.attachment'].sudo().create({
                    'name': filename,
                    'datas': base64.b64encode(data),
                    'res_model': 'discuss.channel',
                    'res_id': channel.id,
                    'type': 'binary',
                    'mimetype': mimetype,
                })
                attachment_ids.append(attachment.id)

            # create message with attachments
            message_type = 'image' if any(f.content_type.startswith('image/') for f in files) else 'file'
            message_body = f'📎 {message_type.capitalize()} attachment'

            message = request.env['mail.message'].sudo().create({
                'body': message_body,
                'message_type': 'whatsapp_message',
                'model': 'discuss.channel',
                'res_id': channel.id,
                'author_id': request.env.user.partner_id.id,
                'subtype_id': request.env.ref('mail.mt_comment').id,
                'attachment_ids': [(6, 0, attachment_ids)],
            })

            # notify channel
            channel._notify_thread(message)

            return json.dumps({
                'success': True,
                'message': {
                    'id': message.id,
                    'body': message_body,
                    'author_name': request.env.user.name,
                    'author_id': request.env.user.partner_id.id,
                    'direction': 'outbound',
                    'create_date': message.create_date,
                    'status': 'sent',
                    'attachment_ids': [{
                        'id': att.id,
                        'name': att.name,
                        'url': f'/web/content/{att.id}?download=true',
                        'mimetype': att.mimetype,
                    } for att in message.attachment_ids],
                }
            })
        except Exception as e:
            _logger.error("Error uploading attachment: %s", str(e))
            return json.dumps({'error': str(e)})

    @http.route('/whatsapp/upload_voice', type='http', auth='user', methods=['POST'], csrf=False)
    def upload_voice(self, channel_id, **post):
        try:
            if 'audio' not in request.httprequest.files:
                return json.dumps({'error': 'No audio file uploaded'})

            if not channel_id:
                return json.dumps({'error': 'Channel ID is required'})

            channel = request.env['discuss.channel'].sudo().browse(int(channel_id))
            if not channel.exists() or channel.channel_type != 'whatsapp':
                return json.dumps({'error': 'WhatsApp channel not found'})

            audio_file = request.httprequest.files['audio']
            data = audio_file.read()
            filename = 'voice_message.webm'

            # create attachment
            attachment = request.env['ir.attachment'].sudo().create({
                'name': filename,
                'datas': base64.b64encode(data),
                'res_model': 'discuss.channel',
                'res_id': channel.id,
                'type': 'binary',
                'mimetype': 'audio/webm',
            })

            # create message with voice attachment
            message = request.env['mail.message'].sudo().create({
                'body': '🎤 Voice message',
                'message_type': 'whatsapp_message',
                'model': 'discuss.channel',
                'res_id': channel.id,
                'author_id': request.env.user.partner_id.id,
                'subtype_id': request.env.ref('mail.mt_comment').id,
                'attachment_ids': [(6, 0, [attachment.id])],
            })

            # notify channel
            channel._notify_thread(message)

            # format the create_date to string to make it json serializable
            create_date = message.create_date.strftime('%Y-%m-%d %H:%M:%S') if message.create_date else None

            return json.dumps({
                'success': True,
                'message': {
                    'id': message.id,
                    'body': '🎤 Voice message',
                    'author_name': request.env.user.name,
                    'author_id': request.env.user.partner_id.id,
                    'direction': 'outbound',
                    'create_date': create_date,
                    'status': 'sent',
                    'attachment_ids': [{
                        'id': attachment.id,
                        'name': filename,
                        'url': f'/web/content/{attachment.id}?download=true',
                        'mimetype': 'audio/webm',
                    }],
                }
            })
        except Exception as e:
            _logger.error("Error uploading voice message: %s", str(e))
            return json.dumps({'error': str(e)}) 