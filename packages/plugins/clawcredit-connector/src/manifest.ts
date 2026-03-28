import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "clawcredit.financial-connector";
const PLUGIN_VERSION = "0.1.0";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ClawCredit",
  description:
    "Credit & payment visibility for autonomous companies. Monitor agent credit lines, repayment obligations, and spending from the Paperclip control plane.",
  author: "ClawCredit",
  categories: ["connector"],

  capabilities: [
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
    "jobs.schedule",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "instance.settings.register",
  ],

  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },

  instanceConfigSchema: {
    type: "object",
    properties: {
      apiToken: {
        type: "string",
        title: "ClawCredit API Token",
        description: "Bearer token from ClawCredit registration",
      },
      serviceUrl: {
        type: "string",
        title: "Service URL (optional)",
        description: "Override the default ClawCredit API endpoint",
      },
      maxTransactionUsd: {
        type: "number",
        title: "Max Transaction (USD)",
        description: "Per-transaction spending cap enforced by the plugin",
        default: 100,
      },
    },
    required: ["apiToken"],
  },

  jobs: [
    {
      jobKey: "sync_transactions",
      displayName: "Sync Transactions",
      description: "Polls ClawCredit for recent transactions and stores them in plugin state",
      schedule: "0 */4 * * *",
    },
  ],

  tools: [
    {
      name: "clawcredit_check_balance",
      displayName: "Check ClawCredit Balance",
      description:
        "Returns the company's available credit, credit score, and repayment status from ClawCredit.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "clawcredit_pay",
      displayName: "Pay via ClawCredit",
      description:
        "Make a payment on credit through ClawCredit. The company's credit line is charged and the merchant receives payment.",
      parametersSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Merchant URL or recipient ID",
          },
          amount: {
            type: "number",
            description: "Amount in USD",
          },
          chain: {
            type: "string",
            enum: ["BASE", "SOLANA", "XRPL"],
            description: "Settlement chain (optional, defaults to BASE)",
          },
          service_name: {
            type: "string",
            description: "Name of the service being purchased",
          },
          description: {
            type: "string",
            description: "Human-readable description of the payment",
          },
          idempotency_key: {
            type: "string",
            description: "Idempotency key to prevent duplicate payments on retry",
          },
        },
        required: ["recipient", "amount"],
      },
    },
  ],

  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "clawcredit-dashboard-widget",
        displayName: "ClawCredit",
        exportName: "ClawCreditWidget",
      },
      {
        type: "page",
        id: "clawcredit-page",
        displayName: "ClawCredit",
        exportName: "ClawCreditPage",
        routePath: "clawcredit",
      },
      {
        type: "settingsPage",
        id: "clawcredit-settings",
        displayName: "ClawCredit Settings",
        exportName: "ClawCreditSettings",
      },
    ],
  },
};

export default manifest;
