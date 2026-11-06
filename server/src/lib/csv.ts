import type { FastifyReply } from 'fastify';

/** RFC 4180 CSV. Cells that look like formulas are prefixed so spreadsheets don't execute them. */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null | undefined>>): string {
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Sends CSV as a download. A BOM makes Excel read UTF-8 names correctly. */
export function sendCsv(reply: FastifyReply, filename: string, csv: string): FastifyReply {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
    .send('﻿' + csv);
}
