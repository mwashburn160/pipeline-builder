# PHP Plugin — build and test PHP applications with Composer
# Used by CodeBuildStep in CodePipeline via pipeline-core Builder
#
# Thin layer over pipeline-php-base (one pinned PHP 8.4 + Composer, shared by
# all PHP plugins). Nothing plugin-specific to add — php, composer, and
# run-logged all come from the base image (SINGLE-VERSION MODEL).

FROM pipeline-php-base:1.0

WORKDIR /app
CMD ["bash"]
