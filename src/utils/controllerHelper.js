/**
 * Shared controller utilities to reduce boilerplate across all controllers.
 */

/**
 * Wraps an async controller function with error handling.
 * Eliminates try-catch boilerplate from every controller function.
 *
 * @param {Function} fn - Async controller function (req, res) => Promise
 * @returns {Function} Wrapped controller function
 */
export const asyncHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    console.error(`${fn.name || 'Controller'} error:`, error);
    res.status(500).json({ message: 'Server error.' });
  }
};

/**
 * Parses pagination parameters from query string.
 *
 * @param {Object} query - req.query object
 * @param {number} [defaultLimit=25] - Default items per page
 * @returns {{ page: number, limit: number, skip: number }}
 */
export const parsePagination = (query, defaultLimit = 25) => {
  const page = parseInt(query.page) || 1;
  const limit = parseInt(query.limit) || defaultLimit;
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

/**
 * Builds a Prisma date range filter from query params.
 * Always sets endDate to 23:59:59.999 to include the full day.
 *
 * @param {string} [startDate] - Start date string
 * @param {string} [endDate] - End date string
 * @returns {Object|undefined} Prisma date filter ({ gte, lte }) or undefined if no dates
 */
export const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return undefined;
  const filter = {};
  if (startDate) filter.gte = new Date(startDate);
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return filter;
};

/**
 * Builds a Prisma OR search filter from a search string and field paths.
 * Supports nested relations via dot notation (e.g., 'campaignData.company').
 *
 * @param {string} search - Search query
 * @param {Array<string|{field: string, mode?: string}>} fields - Field paths to search
 * @returns {Array<Object>|undefined} Array for Prisma OR clause, or undefined if no search
 *
 * @example
 * // Flat fields:
 * buildSearchFilter('acme', ['companyName', 'email'])
 * // → [{ companyName: { contains: 'acme', mode: 'insensitive' } }, ...]
 *
 * // Nested relations:
 * buildSearchFilter('acme', ['leadNumber', 'campaignData.company'])
 * // → [{ leadNumber: { contains: 'acme', mode: 'insensitive' } }, { campaignData: { company: { contains: 'acme', mode: 'insensitive' } } }]
 *
 * // Case-sensitive field (no mode):
 * buildSearchFilter('9876', [{ field: 'campaignData.phone' }])
 * // → [{ campaignData: { phone: { contains: '9876' } } }]
 */
export const buildSearchFilter = (search, fields) => {
  if (!search) return undefined;

  return fields.map((fieldConfig) => {
    const fieldPath = typeof fieldConfig === 'string' ? fieldConfig : fieldConfig.field;
    const mode = typeof fieldConfig === 'string' ? 'insensitive' : fieldConfig.mode;

    const parts = fieldPath.split('.');
    const leaf = { contains: search };
    if (mode) leaf.mode = mode;

    let result = leaf;
    for (let i = parts.length - 1; i >= 0; i--) {
      result = { [parts[i]]: result };
    }
    return result;
  });
};

/**
 * Builds a standardized paginated response object.
 *
 * @param {Object} options
 * @param {Array} options.data - The data array
 * @param {number} options.total - Total count
 * @param {number} options.page - Current page
 * @param {number} options.limit - Items per page
 * @param {string} [options.dataKey='items'] - Key name for the data array
 * @param {Object} [options.extra={}] - Additional top-level fields (e.g., { stats })
 * @returns {Object} Response object with data + pagination
 */
export const paginatedResponse = ({ data, total, page, limit, dataKey = 'items', extra = {} }) => ({
  [dataKey]: data,
  ...extra,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  },
});
