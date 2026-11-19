# frozen_string_literal: true

Dev::PluginRegistry.register("lint") do |_command, args|
  family, *extra = args
  abort "Usage: dev lint go|js|ruby|shell" unless extra.empty? && %w[go js ruby shell].include?(family)

  Dir.chdir(File.expand_path("../..", __dir__)) do
    exec("npm", "run", "lint:#{family}")
  end
end
