/**
 * api/sfms.js
 * One function per API endpoint. Components import from here — never call
 * axios directly — so the base URL and auth header only live in one place.
 */
import client from './client'

// ── Reference data ────────────────────────────────────────────────────────────
export const fetchBusinessUnits = () => client.get('/reference/business-units').then(r => r.data)
export const fetchCurrencies    = () => client.get('/reference/currencies').then(r => r.data)
export const fetchForecastTypes = () => client.get('/reference/forecast-types').then(r => r.data)
export const fetchSalesChannels = () => client.get('/reference/sales-channels').then(r => r.data)
export const fetchPriceTypes    = () => client.get('/reference/price-types').then(r => r.data)
export const fetchBrands        = () => client.get('/reference/brands').then(r => r.data)

export const fetchCustomers = (buCode) =>
  client.get(`/reference/customers/${buCode}`).then(r => r.data)

export const fetchItems = (buCode, brandCode = null) =>
  client.get(`/reference/items/${buCode}`, { params: brandCode ? { brand_code: brandCode } : {} })
    .then(r => r.data)

export const fetchCycles = (forecastTypeCode = null) =>
  client.get('/reference/cycles', { params: forecastTypeCode ? { forecast_type_code: forecastTypeCode } : {} })
    .then(r => r.data)

// ── Current user ──────────────────────────────────────────────────────────────
export const fetchMe = () => client.get('/me').then(r => r.data)

// ── Forecast ──────────────────────────────────────────────────────────────────
export const fetchForecast = (buCode, params) =>
  client.get(`/forecast/${buCode}`, { params }).then(r => r.data)

export const fetchSupplyForecast = (buCode, params) =>
  client.get(`/forecast/${buCode}`, { params }).then(r => r.data)

export const createForecastRow = (buCode, body) =>
  client.post(`/forecast/${buCode}`, body).then(r => r.data)

export const updateForecastRow = (buCode, entryNo, body) =>
  client.put(`/forecast/${buCode}/${entryNo}`, body).then(r => r.data)

export const deleteForecastRow = (buCode, entryNo) =>
  client.delete(`/forecast/${buCode}/${entryNo}`)

// ── GM Copy ──────────────────────────────────────────────────────────────────
export const copyForecastToGM = (buCode, payload) =>
  client.post(`/gm-copy/${buCode}`, payload).then(r => r.data)

// ── Change management ────────────────────────────────────────────────────────
export const fetchChanges = (buCode, params) =>
  client.get(`/changes/${buCode}`, { params }).then(r => r.data)

// ── Actuals & Comparison ──────────────────────────────────────────────────────
export const fetchComparison = (buCode, params) =>
  client.get(`/comparison/${buCode}`, { params }).then(r => r.data)

export const fetchLYActuals = (buCode, params) =>
  client.get(`/actuals/${buCode}/last-year`, { params }).then(r => r.data)

// ── Supply Horizon Admin ──────────────────────────────────────────────────────
export const fetchSupplyHorizons = () =>
  client.get('/admin/supply-horizon').then(r => r.data)

export const createSupplyHorizon = (payload) =>
  client.post('/admin/supply-horizon', payload).then(r => r.data)

export const updateSupplyHorizon = (horizonId, payload) =>
  client.put(`/admin/supply-horizon/${horizonId}`, payload).then(r => r.data)

export const deactivateSupplyHorizon = (horizonId) =>
  client.delete(`/admin/supply-horizon/${horizonId}`).then(r => r.data)