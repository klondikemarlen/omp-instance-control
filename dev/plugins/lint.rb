# frozen_string_literal: true

Dev::PluginRegistry.register("lint") do |_command, args|
  family, *extra = args
  unless extra.empty? && %w[go js shell].include?(family)
    abort "Usage: dev lint go|js|shell"
  end

  Dir.chdir(File.expand_path("../..", __dir__)) do
    exec("npm", "run", "lint:#{family}")
  end
end
