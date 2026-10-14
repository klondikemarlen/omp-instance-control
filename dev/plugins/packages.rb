# frozen_string_literal: true

Dev::PluginRegistry.register("package") do |_command, args|
  exec(File.expand_path("../../bin/package", __dir__), *args)
end

Dev::PluginRegistry.register("sign") do |_command, args|
  exec(File.expand_path("../../bin/sign", __dir__), *args)
end
