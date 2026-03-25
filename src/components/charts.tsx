"use client";
import { useState, useEffect } from "react";

type TimeSeriesData = {
  date: string;
  revenue: number;
  mrr: number;
  customers: number;
  page_views: number;
  signups: number;
  waitlist_signups: number;
  active_companies?: number;
};

type ComparisonData = {
  company_name: string;
  company_slug: string;
  status: string;
  revenue: number;
  mrr: number;
  customers: number;
  page_views: number;
  date: string;
};

type ChartData = {
  type: "timeseries" | "comparison";
  metric: string;
  data: TimeSeriesData[] | ComparisonData[];
  company_id?: string;
};

const METRIC_CONFIGS = {
  mrr: { label: "Monthly Recurring Revenue", color: "#34d399", format: (n: number) => `€${n.toFixed(0)}` },
  revenue: { label: "Total Revenue", color: "#f0b944", format: (n: number) => `€${n.toFixed(0)}` },
  customers: { label: "Customers", color: "#60a5fa", format: (n: number) => n.toString() },
  page_views: { label: "Page Views", color: "#a78bfa", format: (n: number) => n.toLocaleString() },
  signups: { label: "Signups", color: "#34d399", format: (n: number) => n.toString() },
  waitlist_signups: { label: "Waitlist Signups", color: "#fb923c", format: (n: number) => n.toString() },
};

export function TimeSeriesChart({
  metric = "mrr",
  days = 30,
  companyId,
  className = ""
}: {
  metric?: string;
  days?: number;
  companyId?: string;
  className?: string;
}) {
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ metric, days: days.toString(), type: "timeseries" });
    if (companyId) params.set("company_id", companyId);

    fetch(`/api/charts?${params}`)
      .then(res => res.json())
      .then(data => {
        if (data.ok === false) throw new Error(data.error);
        setData(data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [metric, days, companyId]);

  if (loading) return <div className={`${className} animate-pulse bg-gray-100 rounded-lg`}>Loading chart...</div>;
  if (error) return <div className={`${className} text-red-600 p-4`}>Error: {error}</div>;
  if (!data || !Array.isArray(data.data) || data.data.length === 0) {
    return <div className={`${className} text-gray-500 p-4`}>No data available</div>;
  }

  const config = METRIC_CONFIGS[metric as keyof typeof METRIC_CONFIGS];
  const series = data.data as TimeSeriesData[];
  const values = series.map(d => Number(d[metric as keyof TimeSeriesData]) || 0);
  const maxValue = Math.max(...values, 1);
  const minValue = Math.min(...values);

  const width = 600;
  const height = 300;
  const margin = { top: 20, right: 20, bottom: 40, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  // Create path for line chart
  const path = series.map((d, i) => {
    const x = (i / (series.length - 1)) * chartWidth;
    const y = chartHeight - ((values[i] - minValue) / (maxValue - minValue)) * chartHeight;
    return `${i === 0 ? 'M' : 'L'} ${x},${y}`;
  }).join(' ');

  // Create area path (filled under the line)
  const areaPath = `${path} L ${chartWidth},${chartHeight} L 0,${chartHeight} Z`;

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className={className}>
      <div className="mb-3">
        <h3 className="font-semibold text-gray-900">{config.label}</h3>
        <p className="text-sm text-gray-600">Last {days} days</p>
      </div>

      <svg width={width} height={height} className="border rounded-lg bg-white">
        <defs>
          <linearGradient id={`gradient-${metric}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={config.color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={config.color} stopOpacity={0.05} />
          </linearGradient>
        </defs>

        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map(pct => {
            const y = (pct / 100) * chartHeight;
            return (
              <line
                key={pct}
                x1={0}
                y1={y}
                x2={chartWidth}
                y2={y}
                stroke="#f3f4f6"
                strokeWidth={1}
              />
            );
          })}

          {/* Area fill */}
          <path
            d={areaPath}
            fill={`url(#gradient-${metric})`}
          />

          {/* Line */}
          <path
            d={path}
            fill="none"
            stroke={config.color}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Data points */}
          {series.map((d, i) => {
            const x = (i / (series.length - 1)) * chartWidth;
            const y = chartHeight - ((values[i] - minValue) / (maxValue - minValue)) * chartHeight;
            return (
              <circle
                key={i}
                cx={x}
                cy={y}
                r={3}
                fill={config.color}
                className="hover:r-4 transition-all"
              >
                <title>{`${formatDate(d.date)}: ${config.format(values[i])}`}</title>
              </circle>
            );
          })}

          {/* X-axis labels */}
          {series.filter((_, i) => i % Math.ceil(series.length / 5) === 0).map((d, i, filtered) => {
            const originalIndex = series.indexOf(d);
            const x = (originalIndex / (series.length - 1)) * chartWidth;
            return (
              <text
                key={originalIndex}
                x={x}
                y={chartHeight + 20}
                textAnchor="middle"
                fontSize="12"
                fill="#6b7280"
              >
                {formatDate(d.date)}
              </text>
            );
          })}

          {/* Y-axis labels */}
          {[0, 25, 50, 75, 100].map(pct => {
            const value = minValue + ((maxValue - minValue) * (pct / 100));
            const y = chartHeight - (pct / 100) * chartHeight;
            return (
              <text
                key={pct}
                x={-10}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
                fill="#6b7280"
              >
                {config.format(value)}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function ComparisonChart({
  metric = "mrr",
  className = ""
}: {
  metric?: string;
  className?: string;
}) {
  const [data, setData] = useState<ChartData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ metric, type: "comparison" });

    fetch(`/api/charts?${params}`)
      .then(res => res.json())
      .then(data => {
        if (data.ok === false) throw new Error(data.error);
        setData(data);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [metric]);

  if (loading) return <div className={`${className} animate-pulse bg-gray-100 rounded-lg`}>Loading chart...</div>;
  if (error) return <div className={`${className} text-red-600 p-4`}>Error: {error}</div>;
  if (!data || !Array.isArray(data.data) || data.data.length === 0) {
    return <div className={`${className} text-gray-500 p-4`}>No data available</div>;
  }

  const config = METRIC_CONFIGS[metric as keyof typeof METRIC_CONFIGS];
  const companies = data.data as ComparisonData[];
  const values = companies.map(c => Number(c[metric as keyof ComparisonData]) || 0);
  const maxValue = Math.max(...values, 1);

  const width = 600;
  const height = 300;
  const margin = { top: 20, right: 20, bottom: 60, left: 60 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;
  const barWidth = chartWidth / companies.length - 10;

  return (
    <div className={className}>
      <div className="mb-3">
        <h3 className="font-semibold text-gray-900">{config.label} by Company</h3>
        <p className="text-sm text-gray-600">Current values comparison</p>
      </div>

      <svg width={width} height={height} className="border rounded-lg bg-white">
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {[0, 25, 50, 75, 100].map(pct => {
            const y = (pct / 100) * chartHeight;
            return (
              <line
                key={pct}
                x1={0}
                y1={y}
                x2={chartWidth}
                y2={y}
                stroke="#f3f4f6"
                strokeWidth={1}
              />
            );
          })}

          {/* Bars */}
          {companies.map((company, i) => {
            const value = values[i];
            const barHeight = (value / maxValue) * chartHeight;
            const x = (i * (chartWidth / companies.length)) + 5;
            const y = chartHeight - barHeight;

            return (
              <g key={company.company_slug}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={barHeight}
                  fill={config.color}
                  opacity={0.8}
                  className="hover:opacity-100 transition-opacity"
                >
                  <title>{`${company.company_name}: ${config.format(value)}`}</title>
                </rect>

                {/* Company names */}
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 20}
                  textAnchor="middle"
                  fontSize="12"
                  fill="#6b7280"
                  transform={`rotate(-45, ${x + barWidth / 2}, ${chartHeight + 20})`}
                >
                  {company.company_name}
                </text>

                {/* Value labels */}
                <text
                  x={x + barWidth / 2}
                  y={y - 5}
                  textAnchor="middle"
                  fontSize="11"
                  fill="#374151"
                  fontWeight="500"
                >
                  {config.format(value)}
                </text>
              </g>
            );
          })}

          {/* Y-axis labels */}
          {[0, 25, 50, 75, 100].map(pct => {
            const value = (maxValue * (pct / 100));
            const y = chartHeight - (pct / 100) * chartHeight;
            return (
              <text
                key={pct}
                x={-10}
                y={y + 4}
                textAnchor="end"
                fontSize="12"
                fill="#6b7280"
              >
                {config.format(value)}
              </text>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export function ChartControls({
  metric,
  onMetricChange,
  days,
  onDaysChange,
  showDays = true
}: {
  metric: string;
  onMetricChange: (metric: string) => void;
  days?: number;
  onDaysChange?: (days: number) => void;
  showDays?: boolean;
}) {
  return (
    <div className="flex gap-4 mb-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Metric</label>
        <select
          value={metric}
          onChange={(e) => onMetricChange(e.target.value)}
          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
        >
          {Object.entries(METRIC_CONFIGS).map(([key, config]) => (
            <option key={key} value={key}>
              {config.label}
            </option>
          ))}
        </select>
      </div>

      {showDays && onDaysChange && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Time Period</label>
          <select
            value={days}
            onChange={(e) => onDaysChange(Number(e.target.value))}
            className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      )}
    </div>
  );
}