require("capybara")
require('rose-pine').setup({
    disable_background = false,
    disable_float_background = false,
    disable_italics = false,
})

function ColorMyPencils()
    vim.cmd.colorscheme("rose-pine")
end

ColorMyPencils()
require('capybara.packer')