import { format } from "date-fns";

export function formatUsd(value: number | undefined, decimals = 2) {
  if (value === undefined || isNaN(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 4),
  }).format(value);
}

export function formatPercent(value: number | undefined) {
  if (value === undefined || isNaN(value)) return "0.00%";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

export function formatVolume(value: number | undefined) {
  if (value === undefined || isNaN(value)) return "0";
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(2) + "K";
  return value.toFixed(2);
}

export function formatDate(timestamp: number | undefined) {
  if (!timestamp) return "-";
  return format(new Date(timestamp), "MMM d, HH:mm:ss");
}

export function formatNumber(value: number | undefined, decimals = 2) {
  if (value === undefined || isNaN(value)) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 4),
  }).format(value);
}
