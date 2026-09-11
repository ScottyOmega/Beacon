# YNAB MCP Server

A custom [MCP](https://modelcontextprotocol.io) server that connects Claude to [YNAB](https://www.ynab.com) (You Need A Budget). It lets Claude view your budgets, accounts, and categories; search and categorize transactions; suggest categories based on payee history; split transactions; move money between categories; and pull spending reports — all through conversation.

Built as a Claude Desktop Extension (`.mcpb`), which packages the server so it can be installed with a couple of clicks.

## Tools

| Tool | What it does |
|---|---|
| `list_budgets` | Lists all budgets on the account |
| `list_accounts` | Lists open accounts and balances in a budget |
| `list_all_account_balances` | Account balances across every budget |
| `list_categories` | Category groups/categories with balances |
| `create_category_group` | Creates a new category group |
| `create_category` | Creates a new category in an existing group |
| `get_ready_to_assign` | Current "Ready to Assign" amount |
| `get_category_targets` | Lists categories with a target (goal) set, and progress toward it |
| `set_category_target` | Sets, updates, or clears a target (goal) on a category |
| `get_month_summary` | Income/budgeted/spent/age-of-money snapshot |
| `list_overspent_categories` | Categories that went negative this month |
| `spending_by_category` | Total spend per category over a date range |
| `move_money_between_categories` | Moves budgeted money from one category to another |
| `list_uncategorized_transactions` | Transactions with no category yet |
| `list_unapproved_transactions` | Transactions awaiting approval |
| `approve_transaction` | Marks a transaction approved |
| `search_transactions` | Filter by payee, category, account, date range |
| `suggest_category` | Suggests a category for one transaction, based on payee history and amount |
| `bulk_suggest_categories` | Runs `suggest_category` across every uncategorized transaction |
| `categorize_transaction` | Assigns a category to a transaction |
| `split_transaction` | Splits a transaction across multiple categories/amounts |

## Requirements

- [Claude Desktop](https://claude.ai/download) (macOS, Windows, or Linux)
- [Node.js](https://nodejs.org) 18 or later
- A YNAB account and a [Personal Access Token](https://api.ynab.com/#personal-access-tokens) (generate one in YNAB under **Account Settings → Developer Settings → New Token**)

## Installing (as a user)

1. Download `ynab-mcp.mcpb` from the [latest release](../../releases), or build it yourself (see below).
2. Double-click the `.mcpb` file — Claude Desktop will prompt you to install it.
3. In Claude's extension settings for YNAB, paste your Personal Access Token into the field provided. It's stored by Claude Desktop itself, not in this repo or the package.
4. Start a new chat and try: *"list my YNAB budgets."*

## Building from source

```bash
git clone <this-repo-url>
cd ynab-mcp
npm install
npx @anthropic-ai/mcpb pack . ynab-mcp.mcpb
```

Then install the resulting `ynab-mcp.mcpb` as described above.

## Security notes

- Your YNAB token is never stored in this repository or bundled into the `.mcpb` package. It's collected by Claude Desktop's own extension settings UI (a masked field) and injected as an environment variable (`YNAB_ACCESS_TOKEN`) when the server runs.
- The server only talks to `api.ynab.com` using that token; nothing else.
- Tools that change data (`categorize_transaction`, `split_transaction`, `approve_transaction`, `move_money_between_categories`, `create_category`, `create_category_group`, `set_category_target`) only run when Claude explicitly calls them — nothing runs automatically in the background.

## License

MIT
