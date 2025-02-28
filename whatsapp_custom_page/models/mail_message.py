from odoo import models, fields, api, _
from odoo.tools import html2plaintext
import logging
import psycopg2
import json
from datetime import datetime

_logger = logging.getLogger(__name__)

class WhatsAppMessageTemplateComponent(models.Model):
    _name = 'whatsapp.message.template.component'
    _description = 'WhatsApp Message Template Component'

    message_id = fields.Many2one('whatsapp.message', string='Message', ondelete='cascade')
    component_type = fields.Selection([
        ('header', 'Header'),
        ('body', 'Body'),
        ('footer', 'Footer'),
        ('button', 'Button')
    ], string='Component Type', required=True)
    variables = fields.Text('Variables')

class WhatsAppMessage(models.Model):
    _inherit = 'whatsapp.message'  

    # fields from official module
    wa_template_id = fields.Many2one('whatsapp.template', string='Template')
    template_name = fields.Char(related='wa_template_id.name', string='Template Name', readonly=True)
    template_lang_code = fields.Char('Template Language Code')
    component_ids = fields.One2many('whatsapp.message.template.component', 'message_id', string='Components')
    error_message = fields.Text('Error Message')
    retry_count = fields.Integer('Retry Count', default=0)
    last_retry = fields.Datetime('Last Retry')
    failure_type = fields.Selection([
        ('NO_ACCOUNT', 'No WhatsApp Account'),
        ('SEND_ERROR', 'Sending Error'),
        ('API_ERROR', 'API Error'),
        ('TEMPLATE_ERROR', 'Template Error'),
    ], string='Failure Type')
    
    # custom fields
    mobile_number = fields.Char('Mobile Number', required=True)
    mobile_number_formatted = fields.Char('Formatted Mobile Number')
    message_type = fields.Selection([
        ('outbound', 'Outbound'),
        ('inbound', 'Inbound')
    ], string='Message Type', default='outbound', required=True)
    state = fields.Selection([
        ('outgoing', 'Outgoing'),
        ('sent', 'Sent'),
        ('delivered', 'Delivered'),
        ('read', 'Read'),
        ('error', 'Error')
    ], string='Status', default='outgoing', required=True)
    wa_account_id = fields.Many2one('whatsapp.account', string='WhatsApp Account', required=True)
    free_text_json = fields.Text('Message Content')
    mail_message_id = fields.Many2one('mail.message', string='Mail Message')
    attachment_ids = fields.Many2many('ir.attachment', string='Attachments')

    @api.model_create_multi
    def create(self, vals_list):
        records = super().create(vals_list)
        for record in records:
            record._send_message(with_commit=True)
        return records

    def _send_message(self, with_commit=False):
        self.ensure_one()
        try:
            if self.state != 'outgoing':
                return

            if not self.wa_account_id:
                self._handle_error("No WhatsApp account found", failure_type='NO_ACCOUNT')
                return

            # call the parent _send_message method
            return super()._send_message(with_commit=with_commit)

        except Exception as e:
            _logger.error("Error sending WhatsApp message: %s", str(e))
            self._handle_error(str(e), failure_type='SEND_ERROR')

    def _handle_error(self, error_message, failure_type=None):
        """Handle error states consistently"""
        try:
            vals = {
                'state': 'error',
                'error_message': error_message,
            }
            if failure_type:
                vals['failure_type'] = failure_type

            self.write(vals)

            # update related mail message
            if self.mail_message_id:
                self.mail_message_id.write({
                    'whatsapp_status': 'failed',
                    'error_message': error_message
                })
        except Exception as e:
            _logger.error("Error handling message failure: %s", str(e))

    def _prepare_template_components(self):
        """Prepare template components for WhatsApp API"""
        components = []
        if self.component_ids:
            for component in self.component_ids:
                comp_data = {
                    'type': component.component_type,
                    'parameters': []
                }
                if component.variables:
                    variables = json.loads(component.variables)
                    for var in variables:
                        comp_data['parameters'].append({
                            'type': 'text',
                            'text': var
                        })
                components.append(comp_data)
        return components

class MailMessage(models.Model):
    _inherit = 'mail.message'

    is_whatsapp = fields.Boolean('Is WhatsApp Message', default=False)
    whatsapp_status = fields.Selection([
        ('sent', 'Sent'),
        ('delivered', 'Delivered'),
        ('read', 'Read'),
        ('failed', 'Failed')
    ], string='WhatsApp Status', default='sent')
    whatsapp_message_id = fields.Char('WhatsApp Message ID')
    whatsapp_phone = fields.Char('WhatsApp Phone Number')
    official_whatsapp_message_id = fields.Many2one('whatsapp.message', string='Official WhatsApp Message', ondelete='set null')
    error_message = fields.Text('Error Message')

    @api.model
    def create(self, vals):
        # check if this is a message from official WhatsApp module
        if vals.get('message_type') == 'whatsapp' and vals.get('model') == 'discuss.channel':
            channel = self.env['discuss.channel'].sudo().browse(vals.get('res_id'))
            if channel.exists() and channel.channel_type == 'whatsapp':
                vals.update({
                    'is_whatsapp': True,
                    'subtype_id': self.env.ref('mail.mt_comment').id,
                })
                # extract phone number from channel name
                phone = channel.name.split(' - ')[0] if ' - ' in channel.name else channel.name
                phone = ''.join(filter(str.isdigit, phone))
                if phone:
                    vals['whatsapp_phone'] = phone

        # create the message
        message = super().create(vals)

        # wa message created from our custom module
        if message.is_whatsapp and not message.official_whatsapp_message_id:
            try:
                channel = self.env['discuss.channel'].sudo().browse(message.res_id)
                if channel.exists() and channel.channel_type == 'whatsapp':
                    self._create_whatsapp_records(message, channel)
            except Exception as e:
                _logger.error("Error creating WhatsApp records: %s", str(e))
                message.write({
                    'whatsapp_status': 'failed',
                    'error_message': str(e)
                })

        return message

    def write(self, vals):
        result = super().write(vals)

        # handle status updates
        if 'whatsapp_status' in vals:
            for record in self:
                if record.official_whatsapp_message_id:
                    status_mapping = {
                        'sent': 'sent',
                        'delivered': 'delivered',
                        'read': 'read',
                        'failed': 'error'
                    }
                    new_state = status_mapping.get(vals['whatsapp_status'])
                    if new_state:
                        record.official_whatsapp_message_id.write({
                            'state': new_state,
                            'error_message': vals.get('error_message')
                        })

        return result

    def _create_whatsapp_records(self, message, channel):
        if not message.whatsapp_phone:
            return

        try:
            # get wa account
            wa_account = self.env['whatsapp.account'].sudo().search([('active', '=', True)], limit=1)
            if not wa_account:
                _logger.error("No active WhatsApp account found")
                message.whatsapp_status = 'failed'
                return

            # check if we can send a session message
            can_send_session = False
            last_inbound = self.env['mail.message'].sudo().search([
                ('model', '=', 'discuss.channel'),
                ('res_id', '=', channel.id),
                ('message_type', 'in', ['whatsapp_message', 'whatsapp']),
                ('author_id', '!=', self.env.user.partner_id.id),  # not from current user
            ], order='create_date desc', limit=1)

            if last_inbound:
                time_diff = fields.Datetime.now() - last_inbound.create_date
                can_send_session = time_diff.total_seconds() <= 24 * 60 * 60  # 24 hours in seconds

            body = html2plaintext(message.body) if message.body else ''

            # create the message in the official wa module
            WhatsAppMessage = self.env['whatsapp.message'].sudo()
            
            # prepare base values for the official wa message
            base_vals = {
                'mobile_number': message.whatsapp_phone,
                'mobile_number_formatted': message.whatsapp_phone,
                'message_type': 'outbound',
                'state': 'outgoing',
                'wa_account_id': wa_account.id,
                'mail_message_id': message.id,
            }

            # if can't send a session message use a template
            if not can_send_session:
                # first try to find the 'sale' template
                utility_template = self.env['whatsapp.template'].sudo().search([
                    ('name', '=', 'sale'),
                    ('status', '=', 'approved'),
                    ('wa_account_id', '=', wa_account.id)
                ], limit=1)

                if not utility_template:
                    # log template search
                    _logger.info("Sale template not found, searching for any utility template")
                    # search for any utility template using correct field name 'template_type'
                    utility_template = self.env['whatsapp.template'].sudo().search([
                        ('template_type', '=', 'utility'),
                        ('status', '=', 'approved'),
                        ('wa_account_id', '=', wa_account.id)
                    ], limit=1)

                if not utility_template:
                    message.whatsapp_status = 'failed'
                    _logger.error("No approved utility template found")
                    return

                _logger.info("Using WhatsApp template: %s (ID: %s)", utility_template.name, utility_template.id)

                # update base values with template information
                base_vals.update({
                    'wa_template_id': utility_template.id,
                    'template_lang_code': utility_template.lang_code,
                })

                # create the wa message first
                official_message = WhatsAppMessage.create(base_vals)

                if official_message:
                    # get template variables
                    body_variables = utility_template.variable_ids.filtered(lambda v: v.line_type == 'body')
                    
                    # prepare default variable values
                    default_values = [body]  # Use the message as the first variable

                    # create template component
                    component_vals = {
                        'message_id': official_message.id,
                        'component_type': 'body',
                        'variables': json.dumps(default_values),
                    }

                    self.env['whatsapp.message.template.component'].sudo().create(component_vals)

            else:
                # send as regular session message
                base_vals.update({
                    'free_text_json': json.dumps({'body': body}),
                })
                official_message = WhatsAppMessage.create(base_vals)

            if official_message:
                # add attachments if present
                if message.attachment_ids:
                    official_message.write({
                        'attachment_ids': [(6, 0, message.attachment_ids.ids)]
                    })

                # update the mail message
                message.write({
                    'official_whatsapp_message_id': official_message.id,
                    'message_type': 'whatsapp',  # Using whatsapp type for compatibility
                    'whatsapp_status': 'sent'
                })

                # force update channel
                channel.write({
                    'write_date': fields.Datetime.now(),
                })

                # trigger immediate processing
                try:
                    official_message.sudo()._send_message(with_commit=True)
                except Exception as e:
                    _logger.error("Error sending message immediately: %s", str(e))
                    # try using cron job as fallback
                    cron_job = self.env.ref('whatsapp.ir_cron_send_whatsapp_queue')
                    if cron_job:
                        cron_job.sudo()._trigger()

                _logger.info("WhatsApp message created successfully with ID: %s", official_message.id)
            else:
                message.whatsapp_status = 'failed'
                _logger.error("Failed to create WhatsApp message")

        except Exception as e:
            _logger.error("Error creating WhatsApp records: %s", str(e))
            message.whatsapp_status = 'failed'

    @api.model
    def _message_format(self, fnames=None, format_reply=True):
        """Override to add WhatsApp fields to message format"""
        res = super()._message_format(fnames=fnames, format_reply=format_reply)
        
        WhatsAppMessage = self.env['whatsapp.message'].sudo()
        
        for message_dict, message in zip(res, self):
            if message.is_whatsapp or message.message_type in ['whatsapp_message', 'whatsapp']:
                # get the latest status from official message if it exists
                if message.official_whatsapp_message_id:
                    official_msg = WhatsAppMessage.browse(message.official_whatsapp_message_id.id)
                    if official_msg.exists():
                        status_mapping = {
                            'sent': 'sent',
                            'delivered': 'delivered',
                            'read': 'read',
                            'error': 'failed'
                        }
                        message_dict['whatsapp_status'] = status_mapping.get(official_msg.state, 'failed')
                
                message_dict.update({
                    'id': message.id,
                    'is_whatsapp': True,
                    'whatsapp_message_id': message.whatsapp_message_id,
                    'whatsapp_phone': message.whatsapp_phone,
                    'official_whatsapp_message_id': message.official_whatsapp_message_id.id if message.official_whatsapp_message_id else False,
                    'author_id': message.author_id.id if message.author_id else False,
                    'model': message.model,
                    'res_id': message.res_id,
                    'body': message.body or '',
                    'date': message.date,
                    'message_type': 'comment',  # ensure it's treated as a regular message
                    'subtype_id': message.subtype_id.id if message.subtype_id else False,
                })
                
                if message.attachment_ids:
                    message_dict['attachments'] = [{
                        'id': att.id,
                        'name': att.name,
                        'filename': att.name,
                        'mimetype': att.mimetype,
                        'url': f'/web/content/{att.id}?download=true'
                    } for att in message.attachment_ids]
        
        return res

    @api.model
    def _message_post_process_attachments(self, attachments, attachment_ids, message_values):
        """Override to handle WhatsApp attachments properly"""
        result = super()._message_post_process_attachments(attachments, attachment_ids, message_values)
        if message_values.get('message_type') == 'whatsapp' and attachment_ids:
            # ensure attachments are properly linked to both modules
            if message_values.get('official_whatsapp_message_id'):
                self.env['whatsapp.message'].sudo().browse(message_values['official_whatsapp_message_id']).write({
                    'attachment_ids': [(6, 0, attachment_ids)]
                })
        return result 