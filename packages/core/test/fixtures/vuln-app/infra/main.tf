resource "aws_s3_bucket_acl" "assets" {
  bucket = aws_s3_bucket.assets.id
  acl    = "public-read"
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = false
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_security_group" "admin" {
  name = "admin"
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "main" {
  engine              = "postgres"
  instance_class      = "db.t3.micro"
  username            = "app"
  password            = "Sup3rS3cretPw"
  publicly_accessible = true
}

resource "aws_ebs_volume" "data" {
  availability_zone = "us-east-1a"
  size              = 20
  encrypted         = false
}

resource "aws_iam_policy" "admin" {
  name = "admin"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}

data "aws_iam_policy_document" "deploy" {
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["*"]
  }
  statement {
    effect    = "Deny"
    actions   = ["*"]
    resources = ["*"]
  }
}
