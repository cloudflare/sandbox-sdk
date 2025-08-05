"""
Minimal Jupyter configuration focused on kernel-only usage
"""

c = get_config()  # noqa

# Disable all authentication - we handle security at container level
c.ServerApp.token = ''
c.ServerApp.password = ''
c.IdentityProvider.token = ''
c.ServerApp.allow_origin = '*'
c.ServerApp.allow_remote_access = True
c.ServerApp.disable_check_xsrf = True
c.ServerApp.allow_root = True
c.ServerApp.allow_credentials = True

# Also set NotebookApp settings for compatibility
c.NotebookApp.token = ''
c.NotebookApp.password = ''
c.NotebookApp.allow_origin = '*'
c.NotebookApp.allow_remote_access = True
c.NotebookApp.disable_check_xsrf = True
c.NotebookApp.allow_credentials = True

# Performance settings
c.ServerApp.iopub_data_rate_limit = 1000000000  # E2B uses 1GB/s

# Minimal logging
c.Application.log_level = 'ERROR'

# Disable browser
c.ServerApp.open_browser = False

# Optimize for container environment
c.ServerApp.ip = '0.0.0.0'
c.ServerApp.port = 8888

# Kernel optimizations
c.KernelManager.shutdown_wait_time = 0.0
c.MappingKernelManager.cull_idle_timeout = 0
c.MappingKernelManager.cull_interval = 0

# Disable terminals
c.ServerApp.terminals_enabled = False

# Disable all extensions to speed up startup
c.ServerApp.jpserver_extensions = {}
c.ServerApp.nbserver_extensions = {}