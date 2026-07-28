# Shared warning flags, applied per-target via fgp_set_warnings().
# Split by compiler since MSVC and GCC/Clang don't share a flag vocabulary.

function(fgp_set_warnings target)
    target_compile_options(${target} PRIVATE
        $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive- /utf-8>
        $<$<NOT:$<CXX_COMPILER_ID:MSVC>>:-Wall -Wextra -Wpedantic>
    )
endfunction()
