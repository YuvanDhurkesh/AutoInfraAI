require "sinatra"
set :bind, "0.0.0.0"
set :port, ENV.fetch("PORT", 4567)
get("/") { "hello" }
