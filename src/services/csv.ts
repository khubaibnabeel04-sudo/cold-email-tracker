import Papa from 'papaparse';

/**
 * Check if a column name looks like valid CSV header (not binary garbage).
 */
function isValidColumnName(name: string): boolean {
  if (!name || name.trim().length === 0 || name.length > 100) return false;
  // Reject PapaParse auto-generated names from empty/duplicate headers (e.g. _1, _2, _14)
  if (/^_\d+$/.test(name)) return false;
  // Reject if it contains control characters or non-printable bytes
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(name)) return false;
  return true;
}

export async function parseCSV(file: File): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        // Sanitize: remove rows/columns with garbage binary headers
        const cleanedData = (results.data as Record<string, string>[]).map(row => {
          const cleanRow: Record<string, string> = {};
          for (const [key, value] of Object.entries(row)) {
            if (isValidColumnName(key) && key !== '__parsed_extra') {
              cleanRow[key] = value;
            }
          }
          return cleanRow;
        }).filter(row => Object.keys(row).length > 0);

        resolve(cleanedData);
      },
      error: (err) => reject(err)
    });
  });
}