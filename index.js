import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const YNAB_API_BASE = "https://api.ynab.com/v1";

const server = new McpServer({
  name: "ynab-mcp",
  version: "1.0.0",
});

async function ynabFetch(path, options = {}) {
  const token = process.env.YNAB_ACCESS_TOKEN;
  if (!token) {
    throw new Error(
      "No YNAB access token found. Set it in Claude's extension settings for YNAB."
    );
  }
  const response = await fetch(`${YNAB_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    const detail = body?.error?.detail || response.statusText;
    throw new Error(`YNAB API error (${response.status}): ${detail}`);
  }
  return body.data;
}

function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
  };
}

function formatCurrency(milliunits) {
  const dollars = milliunits / 1000;
  const sign = dollars < 0 ? "-" : "";
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

server.tool(
  "hello",
  "Says hello back, to confirm the YNAB MCP server is connected and working.",
  {
    name: z.string().optional().describe("Your name (optional)"),
  },
  async ({ name }) => {
    const greeting = name ? `Hello, ${name}!` : "Hello!";
    return textResult(`${greeting} Your YNAB MCP server is up and running.`);
  }
);

server.tool(
  "list_budgets",
  "Lists all YNAB budgets available to this account, with their IDs and names.",
  {},
  async () => {
    try {
      const data = await ynabFetch("/budgets");
      const budgets = data.budgets.map((b) => ({ id: b.id, name: b.name }));
      return textResult(budgets);
    } catch (error) {
      return errorResult(error);
    }
  }
);

async function fetchOpenAccounts(budget_id) {
  const data = await ynabFetch(`/budgets/${budget_id}/accounts`);
  return data.accounts
    .filter((a) => !a.closed && !a.deleted)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      on_budget: a.on_budget,
      balance: formatCurrency(a.balance),
      cleared_balance: formatCurrency(a.cleared_balance),
      uncleared_balance: formatCurrency(a.uncleared_balance),
    }));
}

server.tool(
  "list_accounts",
  "Lists the open accounts in a budget (checking, savings, credit cards, etc.) with their current balances.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const accounts = await fetchOpenAccounts(budget_id);
      return textResult(accounts);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "list_all_account_balances",
  "Lists account balances across every budget on this account, grouped by budget. Useful for a full net-worth view without checking each budget individually.",
  {},
  async () => {
    try {
      const budgetsData = await ynabFetch("/budgets");
      const results = [];
      for (const budget of budgetsData.budgets) {
        const accounts = await fetchOpenAccounts(budget.id);
        results.push({ budget_name: budget.name, budget_id: budget.id, accounts });
      }
      return textResult(results);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "get_ready_to_assign",
  "Gets the current 'Ready to Assign' amount for a budget — the money not yet assigned to any category this month.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/current`);
      return textResult({
        ready_to_assign: formatCurrency(data.month.to_be_budgeted),
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "move_money_between_categories",
  "Moves budgeted money from one category to another within the same month — e.g. moving $50 from Child Support into Haircuts to cover a specific expense. Reduces the source category's assigned amount and increases the destination's by the same amount. Look up category_id values with list_categories first.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    month: z
      .string()
      .optional()
      .default("current")
      .describe("'current' for this month, or a specific month as YYYY-MM-01."),
    from_category_id: z.string().describe("The category to move money out of."),
    to_category_id: z.string().describe("The category to move money into."),
    amount: z.number().describe("The dollar amount to move, e.g. 50.00. Always positive."),
  },
  async ({ budget_id, month, from_category_id, to_category_id, amount }) => {
    try {
      if (from_category_id === to_category_id) {
        return errorResult(
          new Error("from_category_id and to_category_id must be different.")
        );
      }
      const amountMilliunits = Math.round(amount * 1000);
      const [fromData, toData] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/months/${month}/categories/${from_category_id}`),
        ynabFetch(`/budgets/${budget_id}/months/${month}/categories/${to_category_id}`),
      ]);
      const [updatedFrom, updatedTo] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/months/${month}/categories/${from_category_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            category: { budgeted: fromData.category.budgeted - amountMilliunits },
          }),
        }),
        ynabFetch(`/budgets/${budget_id}/months/${month}/categories/${to_category_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            category: { budgeted: toData.category.budgeted + amountMilliunits },
          }),
        }),
      ]);
      return textResult({
        moved: formatCurrency(amountMilliunits),
        from: {
          category_name: updatedFrom.category.name,
          new_balance: formatCurrency(updatedFrom.category.balance),
        },
        to: {
          category_name: updatedTo.category.name,
          new_balance: formatCurrency(updatedTo.category.balance),
        },
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "list_categories",
  "Lists the category groups and categories in a budget, with their IDs, names, and remaining balances. Use a category's id with categorize_transaction.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const groups = data.category_groups
        .filter((g) => !g.hidden && !g.deleted)
        .map((g) => ({
          group_name: g.name,
          categories: g.categories
            .filter((c) => !c.hidden && !c.deleted)
            .map((c) => ({
              id: c.id,
              name: c.name,
              balance: formatCurrency(c.balance),
            })),
        }));
      return textResult(groups);
    } catch (error) {
      return errorResult(error);
    }
  }
);

const GOAL_TYPE_LABELS = {
  TB: "Target Balance",
  TBD: "Target Balance by Date",
  MF: "Monthly Funding",
  NEED: "Plan Your Spending",
  DEBT: "Debt Payoff",
};

server.tool(
  "get_category_targets",
  "Lists categories that have a target (goal) set, with the target amount, type, due date if any, and progress. Categories without a target are omitted.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const targets = data.category_groups
        .filter((g) => !g.hidden && !g.deleted)
        .flatMap((g) =>
          g.categories
            .filter((c) => !c.hidden && !c.deleted && c.goal_type)
            .map((c) => ({
              category_id: c.id,
              group_name: g.name,
              category_name: c.name,
              target_type: GOAL_TYPE_LABELS[c.goal_type] ?? c.goal_type,
              target_amount: formatCurrency(c.goal_target),
              target_date: c.goal_target_date,
              percentage_complete: c.goal_percentage_complete,
              underfunded_this_month: formatCurrency(c.goal_under_funded ?? 0),
            }))
        );
      if (targets.length === 0) {
        return textResult({ message: "No categories have a target set." });
      }
      return textResult(targets);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "set_category_target",
  "Sets, updates, or clears a target (goal) on a category. Provide either goal_target_date (a one-time target due by a specific date) or goal_frequency (a recurring target), not both. Pass clear_target: true to remove an existing target instead.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    category_id: z.string().describe("The category to set a target on. Look up with list_categories."),
    goal_target: z
      .number()
      .optional()
      .describe("The target dollar amount, e.g. 500.00. Required unless clear_target is true."),
    goal_target_date: z
      .string()
      .optional()
      .describe("Due date for the target, YYYY-MM-DD. Cannot be combined with goal_frequency."),
    goal_frequency: z
      .enum(["monthly", "weekly", "yearly"])
      .optional()
      .describe("Makes the target recurring at this cadence. Cannot be combined with goal_target_date."),
    clear_target: z
      .boolean()
      .optional()
      .default(false)
      .describe("Set true to remove the category's existing target instead of setting one."),
  },
  async ({ budget_id, category_id, goal_target, goal_target_date, goal_frequency, clear_target }) => {
    try {
      let body;
      if (clear_target) {
        body = { goal_target: null };
      } else {
        if (goal_target === undefined) {
          return errorResult(
            new Error("Provide goal_target, or set clear_target: true to remove an existing target.")
          );
        }
        if (goal_target_date && goal_frequency) {
          return errorResult(
            new Error("goal_target_date and goal_frequency can't both be set — a target is either due by a date or recurring, not both.")
          );
        }
        body = { goal_target: Math.round(goal_target * 1000) };
        if (goal_target_date) body.goal_target_date = goal_target_date;
        if (goal_frequency) body.goal_frequency = goal_frequency;
      }
      const data = await ynabFetch(`/budgets/${budget_id}/categories/${category_id}`, {
        method: "PATCH",
        body: JSON.stringify({ category: body }),
      });
      const c = data.category;
      return textResult({
        category_name: c.name,
        target_type: c.goal_type ? GOAL_TYPE_LABELS[c.goal_type] ?? c.goal_type : null,
        target_amount: c.goal_target != null ? formatCurrency(c.goal_target) : null,
        target_date: c.goal_target_date,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "list_uncategorized_transactions",
  "Lists transactions that don't yet have a category assigned, so they can be reviewed and categorized.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions?type=uncategorized`
      );
      const transactions = data.transactions.map((t) => ({
        id: t.id,
        date: t.date,
        payee_name: t.payee_name,
        amount: formatCurrency(t.amount),
        memo: t.memo,
        account_name: t.account_name,
      }));
      return textResult(transactions);
    } catch (error) {
      return errorResult(error);
    }
  }
);

function buildCategorySuggestions(categorizedTransactions, targetAmount) {
  const target = Math.abs(targetAmount);
  const byCategory = new Map();
  for (const t of categorizedTransactions) {
    const dollars = Math.abs(t.amount) / 1000;
    const entry = byCategory.get(t.category_id) ?? {
      category_id: t.category_id,
      category_name: t.category_name,
      amounts: [],
    };
    entry.amounts.push(dollars);
    byCategory.set(t.category_id, entry);
  }
  const suggestions = [...byCategory.values()].map((entry) => {
    const closest = Math.min(
      ...entry.amounts.map((a) => Math.abs(a - target))
    );
    const avg = entry.amounts.reduce((a, b) => a + b, 0) / entry.amounts.length;
    return {
      category_id: entry.category_id,
      category_name: entry.category_name,
      times_used: entry.amounts.length,
      typical_amount: `$${avg.toFixed(2)}`,
      confidence: closest <= 1 ? "strong" : "weak",
      amount_difference_from_closest_match: `$${closest.toFixed(2)}`,
    };
  });
  suggestions.sort(
    (a, b) =>
      parseFloat(a.amount_difference_from_closest_match.slice(1)) -
      parseFloat(b.amount_difference_from_closest_match.slice(1))
  );
  return suggestions;
}

async function findPayeeMatches(budget_id, payee_name) {
  const payeesData = await ynabFetch(`/budgets/${budget_id}/payees`);
  const query = payee_name.toLowerCase();
  return payeesData.payees.filter(
    (p) => !p.deleted && p.name.toLowerCase().includes(query)
  );
}

async function fetchCategorizedHistoryForPayee(budget_id, payee_id) {
  const txData = await ynabFetch(
    `/budgets/${budget_id}/payees/${payee_id}/transactions`
  );
  return txData.transactions.filter((t) => t.category_id && !t.deleted);
}

server.tool(
  "list_unapproved_transactions",
  "Lists transactions that haven't been approved yet (typically bank-imported transactions awaiting review). This is separate from categorization — a transaction can be categorized but still unapproved.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions?type=unapproved`
      );
      const transactions = data.transactions.map((t) => ({
        id: t.id,
        date: t.date,
        payee_name: t.payee_name,
        category_name: t.category_name,
        amount: formatCurrency(t.amount),
        memo: t.memo,
        account_name: t.account_name,
      }));
      return textResult(transactions);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "approve_transaction",
  "Marks a transaction as approved. Look up transaction_id with list_unapproved_transactions first.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    transaction_id: z.string().describe("The ID of the transaction to approve."),
  },
  async ({ budget_id, transaction_id }) => {
    try {
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions/${transaction_id}`,
        {
          method: "PUT",
          body: JSON.stringify({ transaction: { approved: true } }),
        }
      );
      return textResult({
        id: data.transaction.id,
        approved: data.transaction.approved,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "search_transactions",
  "Searches transactions in a budget by payee, category, account, and/or date range. All filters are optional and combine together.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    payee_name: z.string().optional().describe("Partial, case-insensitive match on payee name."),
    category_name: z.string().optional().describe("Partial, case-insensitive match on category name."),
    account_name: z.string().optional().describe("Partial, case-insensitive match on account name."),
    since_date: z.string().optional().describe("Only include transactions on or after this date (YYYY-MM-DD)."),
    until_date: z.string().optional().describe("Only include transactions on or before this date (YYYY-MM-DD)."),
    limit: z.number().optional().default(50).describe("Maximum number of results to return, most recent first."),
  },
  async ({ budget_id, payee_name, category_name, account_name, since_date, until_date, limit }) => {
    try {
      const query = since_date ? `?since_date=${since_date}` : "";
      const data = await ynabFetch(`/budgets/${budget_id}/transactions${query}`);
      const payeeQuery = payee_name?.toLowerCase();
      const categoryQuery = category_name?.toLowerCase();
      const accountQuery = account_name?.toLowerCase();
      const matches = data.transactions.filter((t) => {
        if (t.deleted) return false;
        if (until_date && t.date > until_date) return false;
        if (payeeQuery && !t.payee_name?.toLowerCase().includes(payeeQuery)) return false;
        if (categoryQuery && !t.category_name?.toLowerCase().includes(categoryQuery)) return false;
        if (accountQuery && !t.account_name?.toLowerCase().includes(accountQuery)) return false;
        return true;
      });
      matches.sort((a, b) => (a.date < b.date ? 1 : -1));
      const results = matches.slice(0, limit).map((t) => ({
        id: t.id,
        date: t.date,
        payee_name: t.payee_name,
        category_name: t.category_name,
        amount: formatCurrency(t.amount),
        memo: t.memo,
        account_name: t.account_name,
        approved: t.approved,
      }));
      return textResult({ total_matches: matches.length, results });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "suggest_category",
  "Suggests which category a transaction likely belongs to, based on how past transactions from the same payee were categorized. Especially useful when one payee covers multiple different charges (e.g. two different bills from the same company) that can be told apart by amount.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    payee_name: z
      .string()
      .describe("The payee name to search for (partial match, case-insensitive)."),
    amount: z
      .number()
      .describe("The dollar amount of the transaction to categorize, e.g. 89.99. Sign doesn't matter."),
  },
  async ({ budget_id, payee_name, amount }) => {
    try {
      const matches = await findPayeeMatches(budget_id, payee_name);
      if (matches.length === 0) {
        return textResult({ message: `No payees found matching "${payee_name}".` });
      }
      if (matches.length > 1) {
        return textResult({
          message: "Multiple payees match that name — call again with a more specific payee_name, or pick one of these:",
          matches: matches.map((p) => ({ id: p.id, name: p.name })),
        });
      }
      const payee = matches[0];
      const categorized = await fetchCategorizedHistoryForPayee(budget_id, payee.id);
      if (categorized.length === 0) {
        return textResult({
          message: `No categorized transaction history found for "${payee.name}".`,
        });
      }
      return textResult({
        payee: payee.name,
        suggestions: buildCategorySuggestions(categorized, amount),
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "bulk_suggest_categories",
  "Suggests categories for every uncategorized transaction in a budget at once, using each payee's categorization history. Returns a review list — nothing is applied automatically, use categorize_transaction to apply a suggestion you approve of.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions?type=uncategorized`
      );
      if (data.transactions.length === 0) {
        return textResult({ message: "No uncategorized transactions found." });
      }
      const historyByPayeeId = new Map();
      const results = [];
      for (const t of data.transactions) {
        let suggestions = [];
        if (t.payee_id) {
          if (!historyByPayeeId.has(t.payee_id)) {
            historyByPayeeId.set(
              t.payee_id,
              await fetchCategorizedHistoryForPayee(budget_id, t.payee_id)
            );
          }
          const history = historyByPayeeId.get(t.payee_id);
          if (history.length > 0) {
            suggestions = buildCategorySuggestions(history, t.amount);
          }
        }
        results.push({
          transaction_id: t.id,
          date: t.date,
          payee_name: t.payee_name,
          amount: formatCurrency(t.amount),
          top_suggestion: suggestions[0] ?? null,
          other_suggestions: suggestions.slice(1),
        });
      }
      return textResult(results);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "categorize_transaction",
  "Assigns a category to a specific transaction. Look up category_id with list_categories and transaction_id with list_uncategorized_transactions first.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    transaction_id: z.string().describe("The ID of the transaction to categorize."),
    category_id: z.string().describe("The ID of the category to assign."),
  },
  async ({ budget_id, transaction_id, category_id }) => {
    try {
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions/${transaction_id}`,
        {
          method: "PUT",
          body: JSON.stringify({ transaction: { category_id } }),
        }
      );
      return textResult({
        id: data.transaction.id,
        category_id: data.transaction.category_id,
        category_name: data.transaction.category_name,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "split_transaction",
  "Splits a single transaction across multiple categories with different amounts — e.g. a $75 haircut charge where $50 goes to your category and $25 goes to a category tracking money owed by someone else. Provide at least 2 splits; their amounts must add up to the transaction's total. This cannot be undone via this tool and does not work on transactions that are already split.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    transaction_id: z.string().describe("The ID of the transaction to split."),
    splits: z
      .array(
        z.object({
          category_id: z.string().describe("The category to assign this portion to."),
          amount: z.number().describe("The dollar amount of this portion, e.g. 25.00. Always positive."),
          memo: z.string().optional().describe("Optional note for this portion."),
        })
      )
      .min(2)
      .describe("The portions to split the transaction into. Must sum to the transaction's total amount."),
  },
  async ({ budget_id, transaction_id, splits }) => {
    try {
      const existing = await ynabFetch(
        `/budgets/${budget_id}/transactions/${transaction_id}`
      );
      const total = existing.transaction.amount;
      const sign = total < 0 ? -1 : 1;
      const targetDollars = Math.abs(total) / 1000;
      const splitDollars = splits.reduce((sum, s) => sum + s.amount, 0);
      if (Math.abs(splitDollars - targetDollars) > 0.01) {
        return errorResult(
          new Error(
            `Split amounts add up to $${splitDollars.toFixed(2)}, but the transaction total is $${targetDollars.toFixed(2)}. Adjust the splits so they add up exactly.`
          )
        );
      }
      const subtransactions = splits.map((s) => ({
        amount: Math.round(s.amount * 1000) * sign,
        category_id: s.category_id,
        memo: s.memo,
      }));
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions/${transaction_id}`,
        {
          method: "PUT",
          body: JSON.stringify({
            transaction: { category_id: null, subtransactions },
          }),
        }
      );
      return textResult({
        id: data.transaction.id,
        subtransactions: data.transaction.subtransactions.map((s) => ({
          category_name: s.category_name,
          amount: formatCurrency(s.amount),
          memo: s.memo,
        })),
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "create_category_group",
  "Creates a new category group (a section that categories live under) in a budget.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    name: z.string().max(50).describe("The name of the new category group (max 50 characters)."),
  },
  async ({ budget_id, name }) => {
    try {
      const data = await ynabFetch(`/plans/${budget_id}/category_groups`, {
        method: "POST",
        body: JSON.stringify({ category_group: { name } }),
      });
      return textResult({
        id: data.category_group.id,
        name: data.category_group.name,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "create_category",
  "Creates a new category within an existing category group. Use list_categories first to find the category_group_name, or create one with create_category_group.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    name: z.string().describe("The name of the new category."),
    category_group_name: z
      .string()
      .describe("The name of the existing category group this category should belong to (partial match, case-insensitive)."),
  },
  async ({ budget_id, name, category_group_name }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const query = category_group_name.toLowerCase();
      const matches = data.category_groups.filter(
        (g) => !g.deleted && !g.hidden && g.name.toLowerCase().includes(query)
      );
      if (matches.length === 0) {
        return textResult({
          message: `No category group found matching "${category_group_name}".`,
          available_groups: data.category_groups
            .filter((g) => !g.deleted && !g.hidden)
            .map((g) => g.name),
        });
      }
      if (matches.length > 1) {
        return textResult({
          message: "Multiple category groups match that name — call again with a more specific category_group_name, or pick one of these:",
          matches: matches.map((g) => ({ id: g.id, name: g.name })),
        });
      }
      const group = matches[0];
      const created = await ynabFetch(`/plans/${budget_id}/categories`, {
        method: "POST",
        body: JSON.stringify({
          category: { name, category_group_id: group.id },
        }),
      });
      return textResult({
        id: created.category.id,
        name: created.category.name,
        category_group_name: group.name,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

function firstOfCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function monthsAgo(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function stdDev(nums) {
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - avg) ** 2, 0) / nums.length;
  return { avg, stdDev: Math.sqrt(variance) };
}

server.tool(
  "spending_by_category",
  "Reports total spending per category over a date range (defaults to the current month so far). Excludes transfers between your own accounts.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    since_date: z
      .string()
      .optional()
      .describe("Start date, YYYY-MM-DD. Defaults to the first of the current month."),
    until_date: z.string().optional().describe("End date, YYYY-MM-DD. Defaults to no upper bound."),
  },
  async ({ budget_id, since_date, until_date }) => {
    try {
      const effectiveSince = since_date ?? firstOfCurrentMonth();
      const data = await ynabFetch(
        `/budgets/${budget_id}/transactions?since_date=${effectiveSince}`
      );
      const byCategory = new Map();
      let totalMilliunits = 0;
      for (const t of data.transactions) {
        if (t.deleted || t.transfer_account_id || !t.category_id) continue;
        if (until_date && t.date > until_date) continue;
        const entry = byCategory.get(t.category_id) ?? {
          category_name: t.category_name,
          milliunits: 0,
        };
        entry.milliunits += t.amount;
        byCategory.set(t.category_id, entry);
        totalMilliunits += t.amount;
      }
      const categories = [...byCategory.values()]
        .map((entry) => ({
          category_name: entry.category_name,
          spent: formatCurrency(-entry.milliunits),
        }))
        .sort(
          (a, b) =>
            parseFloat(b.spent.replace(/[$,]/g, "")) -
            parseFloat(a.spent.replace(/[$,]/g, ""))
        );
      return textResult({
        since_date: effectiveSince,
        until_date: until_date ?? null,
        total_spent: formatCurrency(-totalMilliunits),
        categories,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "get_month_summary",
  "Gets a financial snapshot for a budget month: income, total budgeted, total spent, money left to assign, and age of money.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    month: z
      .string()
      .optional()
      .default("current")
      .describe("'current' for this month, or a specific month as YYYY-MM-01."),
  },
  async ({ budget_id, month }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/months/${month}`);
      return textResult({
        month: data.month.month,
        income: formatCurrency(data.month.income),
        budgeted: formatCurrency(data.month.budgeted),
        spent: formatCurrency(-data.month.activity),
        ready_to_assign: formatCurrency(data.month.to_be_budgeted),
        age_of_money_days: data.month.age_of_money,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "list_overspent_categories",
  "Lists categories with a negative balance this month — categories that have been overspent. Informational only; does not move any money.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const data = await ynabFetch(`/budgets/${budget_id}/categories`);
      const overspent = data.category_groups
        .filter((g) => !g.hidden && !g.deleted)
        .flatMap((g) =>
          g.categories
            .filter((c) => !c.hidden && !c.deleted && c.balance < 0)
            .map((c) => ({
              group_name: g.name,
              category_name: c.name,
              balance: formatCurrency(c.balance),
            }))
        )
        .sort(
          (a, b) =>
            parseFloat(a.balance.replace(/[$,]/g, "")) -
            parseFloat(b.balance.replace(/[$,]/g, ""))
        );
      if (overspent.length === 0) {
        return textResult({ message: "No overspent categories — nice work." });
      }
      return textResult(overspent);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "spending_trend",
  "Shows how spending has changed month by month over a recent window — either overall or for one category. Useful for spotting whether spending in an area is creeping up or down over time.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    category_name: z
      .string()
      .optional()
      .describe("Limit the trend to one category (partial, case-insensitive match). Omit for overall spending."),
    months: z
      .number()
      .optional()
      .default(6)
      .describe("How many months back to look, including the current month."),
  },
  async ({ budget_id, category_name, months }) => {
    try {
      const since = monthsAgo(months - 1);
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?since_date=${since}`);
      const query = category_name?.toLowerCase();
      const byMonth = new Map();
      for (const t of data.transactions) {
        if (t.deleted || t.transfer_account_id || !t.category_id) continue;
        if (query && !t.category_name?.toLowerCase().includes(query)) continue;
        const month = t.date.slice(0, 7);
        byMonth.set(month, (byMonth.get(month) ?? 0) + t.amount);
      }
      const trend = [...byMonth.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([month, milliunits]) => ({ month, spent: formatCurrency(-milliunits) }));
      return textResult({
        category: category_name ?? "all categories",
        trend,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "net_worth_snapshot",
  "Totals your current balance across every open account in every budget, into a single net worth figure, plus a per-budget breakdown.",
  {},
  async () => {
    try {
      const budgetsData = await ynabFetch("/budgets");
      let totalMilliunits = 0;
      const budgets = [];
      for (const budget of budgetsData.budgets) {
        const accountsData = await ynabFetch(`/budgets/${budget.id}/accounts`);
        const openAccounts = accountsData.accounts.filter((a) => !a.closed && !a.deleted);
        const budgetTotal = openAccounts.reduce((sum, a) => sum + a.balance, 0);
        totalMilliunits += budgetTotal;
        budgets.push({ budget_name: budget.name, total: formatCurrency(budgetTotal) });
      }
      return textResult({
        net_worth: formatCurrency(totalMilliunits),
        by_budget: budgets,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "top_payees",
  "Reports total spending grouped by payee over a date range (defaults to the current month so far) — who you spend the most money with. Excludes transfers between your own accounts.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    since_date: z
      .string()
      .optional()
      .describe("Start date, YYYY-MM-DD. Defaults to the first of the current month."),
    until_date: z.string().optional().describe("End date, YYYY-MM-DD. Defaults to no upper bound."),
    limit: z.number().optional().default(10).describe("Maximum number of payees to return."),
  },
  async ({ budget_id, since_date, until_date, limit }) => {
    try {
      const effectiveSince = since_date ?? firstOfCurrentMonth();
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?since_date=${effectiveSince}`);
      const byPayee = new Map();
      for (const t of data.transactions) {
        if (t.deleted || t.transfer_account_id || !t.payee_name) continue;
        if (until_date && t.date > until_date) continue;
        byPayee.set(t.payee_name, (byPayee.get(t.payee_name) ?? 0) + t.amount);
      }
      const payees = [...byPayee.entries()]
        .map(([payee_name, milliunits]) => ({ payee_name, spent: formatCurrency(-milliunits) }))
        .sort(
          (a, b) =>
            parseFloat(b.spent.replace(/[$,]/g, "")) - parseFloat(a.spent.replace(/[$,]/g, ""))
        )
        .slice(0, limit);
      return textResult({ since_date: effectiveSince, until_date: until_date ?? null, payees });
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "largest_transactions",
  "Lists the biggest purchases (outflows) in a date range (defaults to the current month so far) — a quick gut-check on where money actually went. Excludes transfers between your own accounts.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    since_date: z
      .string()
      .optional()
      .describe("Start date, YYYY-MM-DD. Defaults to the first of the current month."),
    until_date: z.string().optional().describe("End date, YYYY-MM-DD. Defaults to no upper bound."),
    limit: z.number().optional().default(10).describe("Maximum number of transactions to return."),
  },
  async ({ budget_id, since_date, until_date, limit }) => {
    try {
      const effectiveSince = since_date ?? firstOfCurrentMonth();
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?since_date=${effectiveSince}`);
      const outflows = data.transactions
        .filter((t) => !t.deleted && !t.transfer_account_id && t.amount < 0)
        .filter((t) => !until_date || t.date <= until_date)
        .sort((a, b) => a.amount - b.amount)
        .slice(0, limit)
        .map((t) => ({
          date: t.date,
          payee_name: t.payee_name,
          category_name: t.category_name,
          amount: formatCurrency(t.amount),
          memo: t.memo,
        }));
      return textResult(outflows);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "detect_recurring_charges",
  "Flags payees that appear to bill a consistent amount repeatedly over the last several months — useful for spotting subscriptions, including ones you may have forgotten about. Heuristic: amounts from the same payee that stay within 5% of their average, occurring at least min_occurrences times.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
    lookback_months: z
      .number()
      .optional()
      .default(6)
      .describe("How many months back to look for patterns."),
    min_occurrences: z
      .number()
      .optional()
      .default(3)
      .describe("Minimum number of matching transactions to count as recurring."),
  },
  async ({ budget_id, lookback_months, min_occurrences }) => {
    try {
      const since = monthsAgo(lookback_months - 1);
      const data = await ynabFetch(`/budgets/${budget_id}/transactions?since_date=${since}`);
      const byPayee = new Map();
      for (const t of data.transactions) {
        if (t.deleted || t.transfer_account_id || !t.payee_name || t.amount >= 0) continue;
        const entry = byPayee.get(t.payee_name) ?? { amounts: [], dates: [] };
        entry.amounts.push(Math.abs(t.amount) / 1000);
        entry.dates.push(t.date);
        byPayee.set(t.payee_name, entry);
      }
      const recurring = [];
      for (const [payee_name, entry] of byPayee.entries()) {
        if (entry.amounts.length < min_occurrences) continue;
        const { avg, stdDev: sd } = stdDev(entry.amounts);
        if (avg === 0 || sd / avg > 0.05) continue;
        recurring.push({
          payee_name,
          occurrences: entry.amounts.length,
          typical_amount: `$${avg.toFixed(2)}`,
          most_recent_date: entry.dates.sort().at(-1),
        });
      }
      recurring.sort(
        (a, b) => parseFloat(b.typical_amount.slice(1)) - parseFloat(a.typical_amount.slice(1))
      );
      if (recurring.length === 0) {
        return textResult({ message: "No recurring-charge patterns detected in this window." });
      }
      return textResult(recurring);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.tool(
  "budget_health_check",
  "A single at-a-glance digest of budget health: Ready to Assign, age of money, any overspent categories, and counts of uncategorized/unapproved transactions — instead of checking each separately.",
  {
    budget_id: z
      .string()
      .optional()
      .default("last-used")
      .describe("The budget ID, or 'last-used' for the most recently used budget."),
  },
  async ({ budget_id }) => {
    try {
      const [monthData, categoriesData, uncategorizedData, unapprovedData] = await Promise.all([
        ynabFetch(`/budgets/${budget_id}/months/current`),
        ynabFetch(`/budgets/${budget_id}/categories`),
        ynabFetch(`/budgets/${budget_id}/transactions?type=uncategorized`),
        ynabFetch(`/budgets/${budget_id}/transactions?type=unapproved`),
      ]);
      const overspent = categoriesData.category_groups
        .filter((g) => !g.hidden && !g.deleted)
        .flatMap((g) =>
          g.categories
            .filter((c) => !c.hidden && !c.deleted && c.balance < 0)
            .map((c) => ({ category_name: c.name, balance: formatCurrency(c.balance) }))
        );
      return textResult({
        ready_to_assign: formatCurrency(monthData.month.to_be_budgeted),
        age_of_money_days: monthData.month.age_of_money,
        overspent_categories: overspent,
        uncategorized_transaction_count: uncategorizedData.transactions.length,
        unapproved_transaction_count: unapprovedData.transactions.length,
      });
    } catch (error) {
      return errorResult(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
