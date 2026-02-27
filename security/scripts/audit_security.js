const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BLOCKING_SEVERITIES = new Set(['CRITICAL', 'HIGH']);
const ALLOW_PUBLIC_READ_TABLES = new Set(['plans']);

function parseDatabaseUrlFromEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    const envFile = fs.readFileSync(filePath, 'utf8');
    for (const line of envFile.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('DATABASE_URL=')) {
            return trimmed.slice('DATABASE_URL='.length).replace(/["']/g, '').trim();
        }
    }
    return '';
}

function getDatabaseUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

    const candidates = [
        path.resolve(__dirname, '../.env.local'),
        path.resolve(process.cwd(), '.env.local'),
        path.resolve(process.cwd(), '../.env.local'),
    ];

    for (const candidate of candidates) {
        const value = parseDatabaseUrlFromEnvFile(candidate);
        if (value) return value;
    }

    throw new Error('DATABASE_URL não encontrado. Defina DATABASE_URL no ambiente ou em .env.local');
}

function parseRoles(rawRoles) {
    if (!rawRoles) return [];
    if (Array.isArray(rawRoles)) return rawRoles;
    if (typeof rawRoles !== 'string') return [];

    const trimmed = rawRoles.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return [trimmed];
    const content = trimmed.slice(1, -1).trim();
    if (!content) return [];
    return content.split(',').map((r) => r.replace(/^"+|"+$/g, '').trim()).filter(Boolean);
}

function policyAppliesToPublicOrAuthenticated(roles) {
    if (roles.length === 0) return true;
    return roles.includes('public') || roles.includes('authenticated');
}

function policyOnlyServiceRole(roles) {
    return roles.length > 0 && roles.every((role) => role === 'service_role');
}

function normalizeBoolExpr(expr) {
    return (expr || '').trim().toLowerCase();
}

async function main() {
    const dbUrl = getDatabaseUrl();
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const tablesRes = await client.query(`
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY tablename;
        `);

        const rlsRes = await client.query(`
            SELECT relname AS tablename, relrowsecurity AS rls_enabled
            FROM pg_class
            WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
            ORDER BY relname;
        `);

        const policiesRes = await client.query(`
            SELECT tablename, policyname, cmd, qual, with_check, roles
            FROM pg_policies
            WHERE schemaname = 'public'
            ORDER BY tablename, policyname;
        `);

        const rlsMap = {};
        for (const row of rlsRes.rows) rlsMap[row.tablename] = row.rls_enabled;

        const policyMap = {};
        for (const row of policiesRes.rows) {
            if (!policyMap[row.tablename]) policyMap[row.tablename] = [];
            policyMap[row.tablename].push(row);
        }

        const report = {
            generated_at: new Date().toISOString(),
            summary: {
                table_count: tablesRes.rows.length,
                policy_count: policiesRes.rows.length,
                critical: 0,
                high: 0,
                medium: 0,
                info: 0,
            },
            tables: tablesRes.rows.map((r) => ({
                tablename: r.tablename,
                rls_enabled: rlsMap[r.tablename] || false,
                policy_count: (policyMap[r.tablename] || []).length,
                policies: policyMap[r.tablename] || [],
            })),
            issues: [],
        };

        for (const table of report.tables) {
            if (!table.rls_enabled) {
                report.issues.push({
                    severity: 'HIGH',
                    table: table.tablename,
                    issue: 'RLS não habilitado.',
                });
            } else if (table.policy_count === 0) {
                report.issues.push({
                    severity: 'HIGH',
                    table: table.tablename,
                    issue: 'RLS habilitado, mas sem policies.',
                });
            }

            for (const policy of table.policies) {
                const roles = parseRoles(policy.roles);
                const cmd = (policy.cmd || '').toUpperCase();
                const qual = normalizeBoolExpr(policy.qual);
                const withCheck = normalizeBoolExpr(policy.with_check);
                const isPublic = policyAppliesToPublicOrAuthenticated(roles);
                const isServiceOnly = policyOnlyServiceRole(roles);
                const tableName = table.tablename;

                if (isServiceOnly && (qual === 'true' || withCheck === 'true')) {
                    report.issues.push({
                        severity: 'INFO',
                        table: tableName,
                        policy: policy.policyname,
                        issue: 'Policy de service_role irrestrita (esperado para automações server-side).',
                    });
                    continue;
                }

                if (
                    ALLOW_PUBLIC_READ_TABLES.has(tableName) &&
                    cmd === 'SELECT' &&
                    qual === 'true' &&
                    roles.includes('public')
                ) {
                    report.issues.push({
                        severity: 'INFO',
                        table: tableName,
                        policy: policy.policyname,
                        issue: 'Tabela explicitamente pública para leitura.',
                    });
                    continue;
                }

                if (isPublic && (cmd === 'SELECT' || cmd === 'ALL') && qual === 'true') {
                    report.issues.push({
                        severity: 'HIGH',
                        table: tableName,
                        policy: policy.policyname,
                        issue: 'Leitura irrestrita para public/authenticated.',
                    });
                }

                if (
                    isPublic &&
                    (cmd === 'INSERT' || cmd === 'UPDATE' || cmd === 'DELETE' || cmd === 'ALL') &&
                    (qual === 'true' || withCheck === 'true')
                ) {
                    report.issues.push({
                        severity: 'CRITICAL',
                        table: tableName,
                        policy: policy.policyname,
                        issue: 'Escrita irrestrita para public/authenticated.',
                    });
                }
            }
        }

        for (const issue of report.issues) {
            if (issue.severity === 'CRITICAL') report.summary.critical += 1;
            else if (issue.severity === 'HIGH') report.summary.high += 1;
            else if (issue.severity === 'MEDIUM') report.summary.medium += 1;
            else report.summary.info += 1;
        }

        fs.writeFileSync('/tmp/audit_report.json', JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));

        const hasBlockingIssues = report.issues.some((issue) => BLOCKING_SEVERITIES.has(issue.severity));
        if (hasBlockingIssues) process.exitCode = 1;
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
