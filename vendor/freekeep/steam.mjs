// Derived from FreeKeep for Steam, Copyright (c) 2026 SmailDot. MIT; see LICENSE in this directory.
export const STORE = 'https://store.steampowered.com';
export const STORE_ORIGIN = 'https://store.steampowered.com/*';
export const NO_STORE_ACCESS = 'no_store_access';
export const LOGIN_ORIGIN = 'https://login.steampowered.com/*';
export const RENEW_URL = `https://login.steampowered.com/jwt/refresh?redir=${encodeURIComponent(`${STORE}/?l=english`)}`;
const LIMITED_PROMO = /Limited Free Promotional Package/i;
function parseUserInfo(html) {
    const raw = html.match(/data-userinfo="([^"]*)"/)?.[1];
    if (!raw) return null;
    try {
        return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    } catch  {
        return null;
    }
}
export function parseSession(html) {
    const accountId = Number(html.match(/g_AccountID\s*=\s*(\d+)/)?.[1] ?? 0);
    const userInfo = parseUserInfo(html);
    const userCountry = typeof userInfo?.country_code === 'string' ? userInfo.country_code : null;
    return {
        loggedIn: accountId > 0 || userInfo?.logged_in === true,
        sessionid: html.match(/g_sessionID\s*=\s*"([0-9a-f]+)"/i)?.[1] ?? null,
        country: html.match(/(?:&quot;|")COUNTRY(?:&quot;|"):(?:&quot;|")([A-Z]{2})/)?.[1] ?? (userCountry && /^[A-Z]{2}$/.test(userCountry) ? userCountry : null)
    };
}
export function parseSearchAppIds(json) {
    const items = json?.items ?? [];
    const ids = items.map((it)=>it.logo?.match(/\/apps\/(\d+)\//)?.[1]).filter((id)=>Boolean(id)).map(Number);
    return [
        ...new Set(ids)
    ];
}
function kindOf(type) {
    if (type === 'game') return 'game';
    if (type === 'dlc' || type === 'music') return 'dlc';
    return 'other';
}
export function imageUrl(url) {
    if (typeof url !== 'string') return null;
    try {
        return new URL(url).protocol === 'https:' ? url : null;
    } catch  {
        return null;
    }
}
export function parseAppDetails(appid, json) {
    const entry = json?.[String(appid)];
    if (!entry?.success || !entry.data) return [];
    const d = entry.data;
    const subs = [];
    for (const group of d.package_groups ?? []){
        for (const sub of group.subs ?? []){
            const isFree = sub.is_free_license === true && sub.price_in_cents_with_discount === 0;
            if (!isFree || !LIMITED_PROMO.test(sub.option_text ?? '')) continue;
            const subid = Number(sub.packageid);
            if (!Number.isInteger(subid) || subid <= 0) continue;
            subs.push({
                subid,
                appid,
                name: String(d.name ?? `App ${appid}`),
                kind: kindOf(d.type),
                baseAppid: d.fullgame?.appid ? Number(d.fullgame.appid) : null,
                baseName: d.fullgame?.name ?? null,
                capsule: imageUrl(d.header_image)
            });
        }
    }
    return subs;
}
export function parseEndsText(html) {
    const text = html.match(/Free to keep when you get it before[^<]*?\./i)?.[0];
    return text ? text.replace(/\s+/g, ' ').trim() : null;
}
export function parseOwned(json) {
    const d = json;
    return {
        apps: new Set(d?.rgOwnedApps ?? []),
        packages: new Set(d?.rgOwnedPackages ?? [])
    };
}
export function classifyClaim(status, body) {
    if (status >= 200 && status < 300) return {
        kind: 'claimed'
    };
    if (status === 401) return {
        kind: 'logged_out'
    };
    let detail = null;
    try {
        detail = JSON.parse(body)?.purchaseresultdetail ?? null;
    } catch  {}
    if (detail === 9) return {
        kind: 'owned'
    };
    if (detail === 24) return {
        kind: 'needs_base'
    };
    return {
        kind: 'error',
        code: detail == null ? `http_${status}` : `http_${status}:${detail}`
    };
}
export class SteamClient {
    fetchImpl;
    constructor(fetchImpl = (i, init)=>fetch(i, init)){
        this.fetchImpl = fetchImpl;
    }
    async get(url, withLogin) {
        const res = await this.fetchImpl(url, {
            credentials: withLogin ? 'include' : 'omit',
            cache: 'no-store'
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).pathname}`);
        return res;
    }
    async session() {
        const first = await this.loadSession();
        if (first.loggedIn) return {
            ...first,
            probe: {
                ...first.probe,
                cookiesSent: true
            }
        };
        const second = first.sessionid ? await this.loadSession() : null;
        const cookiesSent = second?.sessionid ? second.sessionid === first.sessionid : null;
        return {
            ...first,
            probe: {
                ...first.probe,
                cookiesSent
            }
        };
    }
    async loadSession() {
        const res = await this.get(`${STORE}/?l=english`, true);
        const html = await res.text();
        const session = parseSession(html);
        const userInfo = parseUserInfo(html);
        let path = '/';
        try {
            path = new URL(res.url).pathname;
        } catch  {}
        return {
            ...session,
            probe: {
                status: res.status,
                path,
                redirected: res.redirected,
                bytes: html.length,
                accountIdSet: /g_AccountID\s*=\s*[1-9]/.test(html),
                userInfoLoggedIn: typeof userInfo?.logged_in === 'boolean' ? userInfo.logged_in : null,
                sessionIdFound: session.sessionid !== null,
                cookiesSent: null
            }
        };
    }
    async renew() {
        const res = await this.fetchImpl(RENEW_URL, {
            credentials: 'include',
            cache: 'no-store'
        });
        await res.text();
        if (!res.ok) throw new Error(`HTTP ${res.status} /jwt/refresh`);
    }
    async searchFreeAppIds(cc) {
        const url = `${STORE}/search/results/?specials=1&maxprice=free&json=1&count=100&l=english&cc=${cc}`;
        return parseSearchAppIds(await (await this.get(url, false)).json());
    }
    async freeSubs(appid, cc) {
        const url = `${STORE}/api/appdetails?appids=${appid}&l=english&cc=${cc}`;
        return parseAppDetails(appid, await (await this.get(url, false)).json());
    }
    async endsText(appid, cc) {
        const url = `${STORE}/app/${appid}/?l=english&cc=${cc}`;
        return parseEndsText(await (await this.get(url, true)).text());
    }
    async owned() {
        return parseOwned(await (await this.get(`${STORE}/dynamicstore/userdata/?t=${Date.now()}`, true)).json());
    }
    async claim(subid, sessionid) {
        const res = await this.fetchImpl(`${STORE}/freelicense/addfreelicense/${subid}`, {
            method: 'POST',
            credentials: 'include',
            body: new URLSearchParams({
                ajax: 'true',
                sessionid
            })
        });
        return classifyClaim(res.status, await res.text());
    }
}
