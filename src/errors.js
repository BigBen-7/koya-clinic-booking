// An error that maps straight to an HTTP response: { "error": message }.
class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

module.exports = { HttpError };
