# Odoo WhatsApp Web Layout Conversation Module

# Integrate With Discuss mail module and Official WhatsApp Business API Module

![Odoo Version](https://img.shields.io/badge/Odoo-17.0-blue)
![License](https://img.shields.io/badge/License-LGPL--3-brightgreen)
![Stage](https://img.shields.io/badge/Stage-Development-orange)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

Custom module for Odoo 17 that bridges the official WhatsApp Business API with Odoo Discuss interface, enabling seamless WhatsApp conversation management directly within the Odoo environment.

<p align="center">
  <img src="https://via.placeholder.com/800x400?text=Odoo+WhatsApp+Module+Screenshot" alt="Module Screenshot" width="800"/>
</p>

## 📋 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Current Issues](#-current-issues)
- [Installation](#-installation)
- [Configuration](#-configuration)
- [Usage](#-usage)
- [Technical Information](#-technical-information)
- [Contributing](#-contributing)
- [Debugging](#-debugging)
- [Roadmap](#-roadmap)
- [License](#-license)
- [Support](#-support)

## 🌟 Overview

This module enhances Odoo communication capabilities by creating a bidirectional integration between the official WhatsApp Business API and Odoo Discuss interface. It allows businesses to:

- Manage WhatsApp conversations through Odoo's familiar interface
- Track customer interactions across channels in a unified timeline
- Access WhatsApp messaging features without leaving Odoo
- Improve team collaboration and customer response times

Perfect for businesses looking to centralize their customer communications and leverage WhatsApp within their existing Odoo workflows.

## 🚀 Key Features

- **Unified Inbox**: Manage WhatsApp messages alongside other communication channels
- **Real-time Synchronization**: Messages appear instantly in both WhatsApp and Odoo (when working correctly)
- **Conversation Threading**: Organized message history with proper threading
- **Rich Media Support**: Send and receive images, documents, voice notes, and other media
- **Message Status Tracking**: Visual indicators for sent, delivered, and read messages
- **Contact Integration**: Seamless connection with Odoo contacts and partners
- **Template Management**: Create and use message templates for quick responses
- **Multi-user Access**: Assign conversations to specific team members
- **History & Analytics**: Track conversation metrics and performance

## 🔧 Current Issues

We are actively seeking contributors to help resolve our primary issue:

**Real-time Message Synchronization in Live Mode**:
- Messages sent from Odoo do not consistently appear in WhatsApp
- Incoming WhatsApp messages sometimes fail to appear in Odoo
- Message status updates (delivered/read) are not reliably transmitted
- Occasional duplicate messages appear in the conversation view

This issue significantly impacts the module's core functionality and is our top priority for resolution.

## 📥 Installation

### Prerequisites
- Odoo 17.0 Community or Enterprise
- Official WhatsApp Business API credentials
- Python 3.10+

### Step-by-Step Installation

1. Clone this repository into your Odoo addons directory:
   ```bash
   git clone https://github.com/cyb3rhex/Odoo-whatsapp-module.git