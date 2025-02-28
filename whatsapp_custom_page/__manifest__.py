{
    'name': 'WhatsApp Custom Page',
    'version': '1.9',
    'category': 'Productivity/Communications',
    'summary': 'Custom WhatsApp Chat Interface',
    'author': "Mustafa Elsergany | Awtad Tech",
    'sequence': 1,
    'description': """
        this module provides a custom WhatsApp chat interface for odoo.
    """,
    'depends': ['base', 'web', 'mail', 'whatsapp'],
    'data': [
        'security/ir.model.access.csv',
        'views/whatsapp_page_menus.xml',
        'views/whatsapp_page_templates.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'whatsapp_custom_page/static/src/js/whatsapp_chat.js',
            'whatsapp_custom_page/static/src/css/whatsapp_chat.scss',
            'whatsapp_custom_page/static/src/xml/whatsapp_chat.xml',
        ],
        'web.assets_common': [
            'whatsapp_custom_page/static/src/img/bg-chat-tile.png',
        ],
    },
    'icon': '/whatsapp_custom_page/static/description/icon.png',
    'web_icon': '/whatsapp_custom_page/static/description/icon.png',
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
} 