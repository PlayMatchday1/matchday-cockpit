-- Retire fin_monthly_expenses.
--
-- Background: city_manager / marketing / equipment used to live as
-- numeric columns on fin_monthly_expenses (one row per city/month).
-- They were placeholder values from initial setup, never edited again.
-- Commit d4f93f6 (2026-05-07) moved those three categories to be
-- line-items on fin_expenses, mirroring how Match Manager Pay already
-- worked. The Cash Flow rollup, Add Expense form, useFinanceData
-- fetch, and FinanceData type all stopped reading from this table at
-- that point.
--
-- This migration drops the now-unused table. The 27 placeholder rows
-- inside it are not preserved (per the migration spec — they were
-- never real spending; backfilling would create fictional line-items).

DROP TABLE IF EXISTS fin_monthly_expenses;
